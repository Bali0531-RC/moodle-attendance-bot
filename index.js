import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { decodeQrFromBuffer } from './qr.js';
import { extractSixCharCode, getAiCredentials, loginGitHubCopilotDeviceFlow } from './extractor.js';
import { ensureMoodleLoggedIn, submitQrUrl, submitSixCharCodeAcrossLinks } from './moodle.js';
import { checkActiveSchedule } from './schedule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const USER_DATA_DIR = path.join(__dirname, '.browser-profile');
const AUTH_STATE_PATH = path.join(__dirname, 'auth.json');

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

// Reload config.json automatically if edited while the bot is running
fs.watchFile(CONFIG_PATH, () => {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    console.log('🔄 [CONFIG] config.json változás észlelve, beállítások és órarend újratöltve!');
  } catch (err) {
    console.warn('⚠️ [CONFIG] Hibás JSON formátum a config.json-ban:', err.message);
  }
});

// Deduplication sets so we only process NEW messages/images arriving after bot startup
const processedTexts = new Set();
const processedImageUrls = new Set();
const recentChatHistory = [];
let activeSubmissionPromise = null;

/**
 * Exports all cookies + localStorage + IndexedDB (Messenger E2EE keys & Microsoft KCA tokens)
 * into a portable auth.json file that works on any headless Linux server.
 */
async function savePortableAuthState(context) {
  try {
    await context.storageState({ path: AUTH_STATE_PATH, indexedDB: true });
    console.log(`💾 [MENTÉS KÉSZ] Hordozható belépési állapot (Cookies + IndexedDB) elmentve ide: ${AUTH_STATE_PATH}`);
  } catch (err) {
    try {
      await context.storageState({ path: AUTH_STATE_PATH });
      console.log(`💾 [MENTÉS KÉSZ] Sütik és localStorage elmentve ide: ${AUTH_STATE_PATH}`);
    } catch (e2) {
      console.error(`❌ [MENTÉS HIBA] ${e2.message}`);
    }
  }
}

/**
 * Restores cookies from auth.json into the persistent context if available (useful right after moving to a new server).
 */
async function restorePortableAuthStateIfPresent(context) {
  if (!fs.existsSync(AUTH_STATE_PATH)) return;
  try {
    const state = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf-8'));
    if (Array.isArray(state.cookies) && state.cookies.length > 0) {
      await context.addCookies(state.cookies);
      console.log(`🔑 [AUTH BETÖLTVE] ${state.cookies.length} süti betöltve az auth.json fájlból!`);
    }
  } catch (err) {
    console.warn(`⚠️ [AUTH BETÖLTÉS] Nem sikerült betölteni az auth.json-t: ${err.message}`);
  }
}

/**
 * Downloads an image URL using the Messenger page's context/cookies into memory Buffer.
 */
async function fetchImageBuffer(context, page, imgSrc) {
  try {
    if (imgSrc.startsWith('data:image/')) {
      const base64Data = imgSrc.split(',')[1];
      return Buffer.from(base64Data, 'base64');
    }
    if (imgSrc.startsWith('blob:')) {
      const base64 = await page.evaluate(async (blobUrl) => {
        const res = await fetch(blobUrl);
        const blob = await res.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
      }, imgSrc);
      return Buffer.from(base64, 'base64');
    }
    const response = await context.request.get(imgSrc, { timeout: 4000 });
    if (response.ok()) {
      return await response.body();
    }
  } catch (err) {
    console.warn(`[KÉP LETÖLTÉS HIBA] ${err.message}`);
  }
  return null;
}

/**
 * Handles a newly detected image in the Messenger chat (< 200ms).
 */
async function onNewChatImage(context, messengerPage, moodlePage, imgSrc, bypassSchedule = false) {
  if (!imgSrc || processedImageUrls.has(imgSrc)) return;
  if (imgSrc.includes('emoji') || imgSrc.includes('p50x50') || imgSrc.includes('p36x36')) return;

  processedImageUrls.add(imgSrc);

  if (!bypassSchedule) {
    const sched = checkActiveSchedule(config);
    if (!sched.active) {
      console.log(`⏸️ [ALVÓ MÓD - KÉP IGNORÁLVA] ${sched.reason}`);
      return;
    }
  }

  const t0 = Date.now();
  const buffer = await fetchImageBuffer(context, messengerPage, imgSrc);
  if (!buffer) return;

  const decoded = await decodeQrFromBuffer(buffer);
  const decodeMs = Date.now() - t0;

  if (decoded) {
    console.log(`\n📸 [QR DETEKTÁLVA - ${decodeMs}ms] Tartalom: ${decoded}`);
    if (/^https?:\/\//i.test(decoded)) {
      await submitQrUrl(moodlePage, decoded);
    } else if (/^[A-Za-z0-9]{6}$/.test(decoded)) {
      console.log(`🔑 [QR 6-JEGYŰ KÓD] A QR kód egy 6 jegyű kódot rejtett: ${decoded}`);
      triggerSixCharSubmission(moodlePage, decoded);
    }
  }
}

/**
 * Handles a newly detected text message in the Messenger chat.
 */
async function onNewChatMessage(moodlePage, text, bypassSchedule = false) {
  const clean = text.trim();
  if (!clean || processedTexts.has(clean)) return;
  processedTexts.add(clean);

  recentChatHistory.push(clean);
  if (recentChatHistory.length > 6) recentChatHistory.shift();

  if (!bypassSchedule) {
    const sched = checkActiveSchedule(config);
    if (!sched.active) {
      console.log(`⏸️ [ALVÓ MÓD - ÜZENET IGNORÁLVA] "${clean}" | ${sched.reason}`);
      return;
    }
  }

  console.log(`💬 [ÚJ ÜZENET] "${clean}"`);

  // Check if someone pasted a direct Moodle attendance link in chat
  const linkMatch = clean.match(/https?:\/\/\S+mod\/attendance\/\S+/i);
  if (linkMatch) {
    console.log(`🔗 [ATTENDANCE LINK CHATBEN] ${linkMatch[0]}`);
    await submitQrUrl(moodlePage, linkMatch[0]);
    return;
  }

  const code = await extractSixCharCode(clean, recentChatHistory);
  if (code) {
    console.log(`🎯 [6-JEGYŰ KÓD AZONOSÍTVA] -> "${code}"`);
    triggerSixCharSubmission(moodlePage, code);
  }
}

function triggerSixCharSubmission(moodlePage, code) {
  activeSubmissionPromise = Promise.resolve(activeSubmissionPromise).then(() =>
    submitSixCharCodeAcrossLinks(moodlePage, code, config)
  );
}

/**
 * Injects a real-time MutationObserver into the Messenger tab so new messages/images
 * trigger Node.js callbacks in < 50ms without polling delay.
 */
async function attachMessengerObserver(context, messengerPage, moodlePage) {
  await messengerPage.exposeFunction('__botOnNewText', (text) => {
    onNewChatMessage(moodlePage, text, false);
  });

  await messengerPage.exposeFunction('__botOnNewImage', (src) => {
    onNewChatImage(context, messengerPage, moodlePage, src, false);
  });

  const setupObserverScript = () => {
    if (window.__attendanceObserverActive) return;
    window.__attendanceObserverActive = true;

    const seenTextNodes = new WeakSet();
    const seenImgNodes = new WeakSet();

    const markExisting = () => {
      document.querySelectorAll('div[dir="auto"]').forEach((el) => seenTextNodes.add(el));
      document.querySelectorAll('img[src]').forEach((img) => seenImgNodes.add(img));
    };

    setTimeout(() => {
      markExisting();
      console.log('[Bot Observer] Kezdeti üzenetek megjegyezve, élő figyelés aktív!');

      const scanNode = (root) => {
        if (!root || !root.querySelectorAll) return;

        const imgs = root.matches?.('img[src]') ? [root] : [...root.querySelectorAll('img[src]')];
        for (const img of imgs) {
          if (seenImgNodes.has(img)) continue;
          const checkImg = () => {
            if (img.src && (img.naturalWidth === 0 || img.naturalWidth >= 80)) {
              seenImgNodes.add(img);
              window.__botOnNewImage(img.src);
            }
          };
          if (img.complete) checkImg();
          else img.addEventListener('load', checkImg, { once: true });
        }

        const textDivs = root.matches?.('div[dir="auto"]')
          ? [root]
          : [...root.querySelectorAll('div[dir="auto"]')];
        for (const div of textDivs) {
          if (seenTextNodes.has(div)) continue;
          seenTextNodes.add(div);
          const txt = (div.innerText || '').trim();
          if (txt && txt.length >= 2 && txt.length <= 300) {
            window.__botOnNewText(txt);
          }
        }
      };

      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            scanNode(node);
          }
          if (m.type === 'attributes' && m.target?.tagName === 'IMG') {
            scanNode(m.target);
          }
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
      });
    }, 3500);
  };

  await messengerPage.addInitScript(setupObserverScript);
  await messengerPage.evaluate(setupObserverScript).catch(() => {});
}

/**
 * Interactive CLI menu so you can test simulated messages, QR images, or export auth state anytime!
 */
function startInteractiveCli(context, messengerPage, moodlePage) {
  const aiCreds = getAiCredentials();
  const sched = checkActiveSchedule(config);

  console.log('\n============================================================');
  console.log('🤖 MOODLE ATTENDANCE BOT FUT ÉS FIGYEL!');
  console.log(`🧠 AI Motor: ${aiCreds ? (aiCreds.isCopilot ? 'GitHub Copilot (AKTÍV ✅)' : 'Egyéni API (AKTÍV ✅)') : 'Csak Regex'}`);
  console.log(`⏰ Órarend státusz: ${sched.active ? '🟢 AKTÍV' : '🟡 ALVÓ MÓD'} -> ${sched.reason}`);
  console.log('------------------------------------------------------------');

  if (!process.stdin.isTTY) {
    console.log('🤖 [SZERVER MÓD] Háttérben (non-interactive) futás aktív 0-24!');
    console.log('============================================================\n');
    return;
  }

  console.log('Parancsok a terminálban:');
  console.log('  • save                                -> Kimenti az auth.json-t szerverre költöztetéshez');
  console.log('  • copilot-login                       -> Új GitHub Copilot fiók beléptetése');
  console.log('  • Bármilyen szöveg (pl. "kód: AB12CD") -> Szimulál egy Messenger üzenetet (idősávtól függetlenül!)');
  console.log('  • qr /eleresi/ut/kep.png              -> Letesztel egy QR kódos képfájlt');
  console.log('  • status                              -> Ellenőrzi a belépett füleket és az órarendet');
  console.log('  • exit                                -> Mentés és kilépés');
  console.log('============================================================\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) return;

    if (input === 'save' || input === 'export') {
      await savePortableAuthState(context);
      return;
    }

    if (input === 'copilot-login') {
      await loginGitHubCopilotDeviceFlow();
      return;
    }

    if (input === 'exit' || input === 'quit') {
      console.log('Belépési állapot mentése és leállítás...');
      await savePortableAuthState(context);
      await context.close();
      process.exit(0);
    }

    if (input === 'status') {
      const currentSched = checkActiveSchedule(config);
      console.log(`📌 Messenger fül URL: ${messengerPage.url()}`);
      console.log(`📌 Moodle fül URL:    ${moodlePage.url()}`);
      console.log(`⏰ Órarend státusz:   ${currentSched.active ? '🟢 AKTÍV' : '🟡 ALVÓ MÓD'} (${currentSched.reason})`);
      return;
    }

    if (input.startsWith('qr ')) {
      const filePath = input.slice(3).trim();
      if (!fs.existsSync(filePath)) {
        console.log(`❌ Nem található fájl: ${filePath}`);
        return;
      }
      const t0 = Date.now();
      const buf = fs.readFileSync(filePath);
      const decoded = await decodeQrFromBuffer(buf);
      console.log(`📸 [TESZT QR - ${Date.now() - t0}ms] Dekódolt érték: ${decoded || 'NEM TALÁLHATÓ QR'}`);
      if (decoded && /^https?:\/\//i.test(decoded)) {
        await submitQrUrl(moodlePage, decoded);
      }
      return;
    }

    // Manual CLI test bypasses schedule check so you can test anytime at night/weekends!
    processedTexts.delete(input);
    await onNewChatMessage(moodlePage, input, true);
  });
}

async function main() {
  const isHeadless = process.env.HEADLESS === 'true' || Boolean(config.headless);
  console.log(
    `🚀 Böngésző indítása (${isHeadless ? 'HEADLESS SZERVER MÓD' : 'ABLAKOS MÓD'}) elmentett profillal...`
  );

  for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(USER_DATA_DIR, lockFile);
    try {
      if (fs.existsSync(p) || fs.lstatSync(p)) fs.unlinkSync(p);
    } catch {}
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: isHeadless,
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--password-store=basic',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  await restorePortableAuthStateIfPresent(context);

  const pages = context.pages();
  const messengerPage = pages[0] || (await context.newPage());
  const moodlePage = pages[1] || (await context.newPage());

  await attachMessengerObserver(context, messengerPage, moodlePage);

  console.log(`🌐 Messenger megnyitása: ${config.messenger_group_url}`);
  await messengerPage.goto(config.messenger_group_url, { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log(`🎓 Moodle megnyitása: ${config.moodle_base_url}`);
  await moodlePage.goto(config.moodle_base_url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await ensureMoodleLoggedIn(moodlePage, config.moodle_base_url);

  setTimeout(() => savePortableAuthState(context), 15000);

  // Keep Moodle + KCA session alive
  const keepAliveMs = (config.keep_alive_minutes || 10) * 60 * 1000;
  setInterval(async () => {
    try {
      if (!activeSubmissionPromise) {
        console.log('🔄 [KEEP-ALIVE] Moodle & KCA session frissítése...');
        await moodlePage.goto(config.moodle_base_url, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await ensureMoodleLoggedIn(moodlePage, config.moodle_base_url);
        await savePortableAuthState(context);
      }
    } catch {}
  }, keepAliveMs);

  startInteractiveCli(context, messengerPage, moodlePage);
}

main().catch((err) => {
  console.error('Végzetes hiba:', err);
  process.exit(1);
});
