import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_COPILOT_TOKEN_FILE = path.join(__dirname, '.copilot-token.json');
const OPENCODE_AUTH_FILE = path.join(os.homedir(), '.local/share/opencode/auth.json');

// Common 6-letter Hungarian/English chat words to ignore before even calling AI
const STOPWORDS = new Set([
  'minden', 'valaki', 'valami', 'szerint', 'holnap', 'tegnap', 'amikor',
  'viszont', 'szoval', 'szóval', 'persze', 'nekem', 'nektek', 'nekunk',
  'hogyan', 'milyen', 'nagyon', 'kicsit', 'csakaz', 'teszt1', 'online',
  'moodle', 'kuldte', 'küldte', 'küldöm', 'kuldom', 'beirta', 'beírta',
  'sziasz', 'helloo', 'köszi!', 'koszii', 'köszön', 'rendbe', 'jolesz'
]);

/**
 * Resolves the GitHub Copilot token or custom AI_API_KEY from:
 * 1. process.env.COPILOT_TOKEN or process.env.AI_API_KEY
 * 2. .copilot-token.json in the project folder (portable to your headless server!)
 * 3. ~/.local/share/opencode/auth.json
 */
export function getAiCredentials() {
  if (process.env.COPILOT_TOKEN?.trim()) {
    return { token: process.env.COPILOT_TOKEN.trim(), isCopilot: true };
  }
  if (process.env.AI_API_KEY?.trim()) {
    return { token: process.env.AI_API_KEY.trim(), isCopilot: false };
  }
  if (fs.existsSync(LOCAL_COPILOT_TOKEN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(LOCAL_COPILOT_TOKEN_FILE, 'utf-8'));
      if (data.token) return { token: data.token, isCopilot: true };
    } catch {}
  }
  if (fs.existsSync(OPENCODE_AUTH_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(OPENCODE_AUTH_FILE, 'utf-8'));
      const ghToken = data['github-copilot']?.access;
      if (ghToken) {
        // Also save locally so moving the folder to the server includes it automatically
        try {
          fs.writeFileSync(LOCAL_COPILOT_TOKEN_FILE, JSON.stringify({ token: ghToken }, null, 2));
        } catch {}
        return { token: ghToken, isCopilot: true };
      }
    } catch {}
  }
  return null;
}

/**
 * Interactive GitHub Copilot Device Flow login (in case someone wants to authenticate a new GitHub account)
 */
export async function loginGitHubCopilotDeviceFlow() {
  const CLIENT_ID = 'Iv1.b507a08c87ecfe98'; // Official GitHub Copilot VSCode Client ID
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user' }),
  });
  const data = await res.json();
  console.log('\n============================================================');
  console.log('🐙 GITHUB COPILOT BEJELENTKEZÉS');
  console.log(`1. Nyisd meg: ${data.verification_uri}`);
  console.log(`2. Írd be ezt a kódot: ${data.user_code}`);
  console.log('============================================================\n');

  const intervalMs = (data.interval || 5) * 1000;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const poll = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: data.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const pollData = await poll.json();
    if (pollData.access_token) {
      fs.writeFileSync(
        LOCAL_COPILOT_TOKEN_FILE,
        JSON.stringify({ token: pollData.access_token }, null, 2)
      );
      console.log('✅ GitHub Copilot sikeresen összekötve és elmentve (.copilot-token.json)!');
      return true;
    }
  }
  console.log('❌ Bejelentkezés időtúllépés.');
  return false;
}

/**
 * Extracts a 6-character Moodle attendance code from a chat message.
 * - Instant path (0ms): Single 6-char word or explicit "kód: ABC123" -> no AI call needed!
 * - Pre-filter: If the message doesn't contain ANY 6-character alphanumeric word, AI is NEVER called!
 * - GitHub Copilot AI path (~250ms): Evaluates context when a message contains a 6-char word inside a sentence.
 */
export async function extractSixCharCode(messageText, recentMessages = []) {
  const clean = messageText.trim();
  if (!clean) return null;

  // Ignore URLs
  if (/^https?:\/\//i.test(clean)) return null;

  // 1. Direct single-token message: e.g. "x7b9k2" or "AB12CD" (0ms, no AI call wasted)
  if (/^[A-Za-z0-9]{6}$/.test(clean)) {
    if (!STOPWORDS.has(clean.toLowerCase())) {
      return clean;
    }
  }

  // 2. Explicit prefix pattern: "kód: abc123", "kod abc123", "code: 123456" (0ms, no AI call wasted)
  const explicitMatch = clean.match(/(?:k[oó]d|jelsz[oó]|pass|code)\s*[:=-]?\s*\b([A-Za-z0-9]{6})\b/i);
  if (explicitMatch) {
    return explicitMatch[1];
  }

  // 3. Pre-filter: Find any 6-char alphanumeric words in the text (strip URLs first).
  // If there is NO 6-character word in the message, we DO NOT call AI at all!
  const textWithoutUrls = clean.replace(/https?:\/\/\S+/gi, '');
  const candidates = [...textWithoutUrls.matchAll(/\b([A-Za-z0-9]{6})\b/g)]
    .map((m) => m[1])
    .filter((token) => !STOPWORDS.has(token.toLowerCase()));

  if (candidates.length === 0) {
    return null;
  }

  // 4. Call GitHub Copilot (or custom OpenAI endpoint) to verify if the 6-char word in the sentence is an attendance code
  const creds = getAiCredentials();
  if (creds) {
    try {
      const baseUrl = creds.isCopilot
        ? 'https://api.githubcopilot.com'
        : (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
      const model = process.env.AI_MODEL || 'gpt-4o-mini';
      const contextStr = recentMessages.slice(-3).join('\n');

      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.token}`,
      };
      if (creds.isCopilot) {
        headers['Editor-Version'] = 'vscode/1.96.0';
        headers['Copilot-Integration-Id'] = 'vscode-chat';
        headers['User-Agent'] = 'opencode/1.0';
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 20,
          messages: [
            {
              role: 'system',
              content:
                'You extract 6-character Moodle attendance passwords from university group chat messages (Hungarian/English). Reply ONLY with the exact 6-character code, or "NONE" if the message is normal conversation and not sharing an attendance code.',
            },
            {
              role: 'user',
              content: `Recent chat context:\n${contextStr}\n\nNew message: "${clean}"\nCandidate 6-char words: ${candidates.join(', ')}`,
            },
          ],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const reply = (data.choices?.[0]?.message?.content || 'NONE').trim();
        console.log(`🤖 [COPILOT AI] Válasz a(z) "${clean}" üzenetre: ${reply}`);
        if (/^[A-Za-z0-9]{6}$/.test(reply) && reply.toUpperCase() !== 'NONE') {
          return reply;
        }
        return null;
      } else {
        console.warn(`⚠️ [COPILOT AI] HTTP ${response.status} - fallback okos regexre.`);
      }
    } catch (err) {
      console.warn('[COPILOT AI] Hiba a hívásnál, fallback okos regexre:', err.message);
    }
  }

  // 5. Smart Regex fallback (if offline or AI error)
  for (const cand of candidates) {
    const hasDigit = /\d/.test(cand);
    const hasUpper = /[A-Z]/.test(cand);
    if (hasDigit || hasUpper || clean.split(/\s+/).length <= 2) {
      return cand;
    }
  }

  return null;
}
