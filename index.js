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
 * Checks if the context actually has a logged-in Messenger user cookie (c_user + xs)
 * AND a logged-in Moodle / Microsoft session before overwriting auth.json!
 */
async function hasValidMessengerSession(context) {
  try {
    const cookies = await context.cookies(['https://www.messenger.com', 'https://www.facebook.com']);
    const hasCUser = cookies.some((c) => c.name === 'c_user' && c.value);
    const hasXs = cookies.some((c) => c.name === 'xs' && c.value);
    return hasCUser && hasXs;
  } catch {
    return false;
  }
}

/**
 * Detects if Messenger tab is logged out, asking for "Continue as...", or asking for the 6-digit E2EE PIN.
 * Automatically recovers if possible or logs a clear alert!
 */
export async function checkAndRecoverMessengerSession(context, messengerPage) {
  try {
    const url = messengerPage.url();
    const cookiesValid = await hasValidMessengerSession(context);

    // 1. Check if there is a "Continue as [Name]" / "Folytatás mint..." one-click button
    const continueBtn = messengerPage
      .locator(
        'button:has-text("Continue as"), button:has-text("Folytatás"), div[role="button"]:has-text("Continue as"), div[role="button"]:has-text("Folytatás")'
      )
      .first();
    if ((await continueBtn.count()) > 0 && (await continueBtn.isVisible())) {
      console.log('🔐 [MESSENGER AUTO-LOGIN] "Folytatás mint..." gomb észlelve, kattintás...');
      await continueBtn.click();
      await messengerPage.waitForTimeout(3000);
    }

    // 2. Check if Messenger is asking for email + password login form
    const loginInput = messengerPage.locator('input[name="email"], input#email').first();
    const passInput = messengerPage.locator('input[name="pass"], input#pass').first();
    const isLoginScreen =
      !cookiesValid ||
      url.includes('/login') ||
      ((await loginInput.count()) > 0 && (await loginInput.isVisible()));

    if (isLoginScreen) {
      const fbEmail = process.env.FB_EMAIL?.trim();
      const fbPass = process.env.FB_PASS?.trim();

      if (fbEmail && fbPass && (await loginInput.count()) > 0) {
        console.log('🔐 [MESSENGER AUTO-LOGIN] Kijelentkezés észlelve! Automatikus belépés FB_EMAIL / FB_PASS-szal...');
        await loginInput.fill(fbEmail);
        await passInput.fill(fbPass);
        const keepSignedIn = messengerPage.locator('input[name="persistent"], input[type="checkbox"]').first();
        if ((await keepSignedIn.count()) > 0) {
          await keepSignedIn.check().catch(() => {});
        }
        const submitBtn = messengerPage.locator('button[name="login"], button#loginbutton, button[type="submit"]').first();
        await Promise.all([
          messengerPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
          submitBtn.click(),
        ]);
        await messengerPage.waitForTimeout(4000);
      } else {
        console.error(
          `🚨 [MESSENGER KIJELENTKEZVE!] A Messenger nincs belépve (hiányzik a c_user/xs süti, URL: ${url})! Lépj be újra és futtasd a "save" parancsot (vagy add meg az FB_EMAIL / FB_PASS értékeket a .env-ben)!`
        );
        return false;
      }
    }

    // 3. Check if Messenger E2EE (End-to-End Encryption) 6-digit PIN modal popped up
    const pinInput = messengerPage
      .locator(
        'input[autocomplete="one-time-code"], input#mw-numeric-code-input-prevent-composer-focus-steal, input[aria-label*="PIN" i], input[aria-label*="kód" i]'
      )
      .first();
    if ((await pinInput.count()) > 0 && (await pinInput.isVisible())) {
      const e2eePin = process.env.MESSENGER_PIN?.trim() || config.messenger_pin;
      if (e2eePin) {
        console.log('🔐 [MESSENGER E2EE PIN] Titkosított chat PIN ablak észlelve, automatikus kitöltés...');
        await pinInput.fill(String(e2eePin));
        await messengerPage.waitForTimeout(2000);
      } else {
        console.warn(
          '⚠️ [MESSENGER E2EE PIN] A Messenger kéri a 6-jegyű titkosítási PIN kódot! Add meg a .env-ben (MESSENGER_PIN=123456) vagy írd be az ablakban!'
        );
      }
    }

    // 4. Verify we are actually on the target group thread
    if (
      cookiesValid &&
      config.messenger_group_url &&
      !messengerPage.url().includes('/t/')
    ) {
      await messengerPage.goto(config.messenger_group_url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    const finalValid = await hasValidMessengerSession(context);
    if (finalValid) {
      console.log('✅ [MESSENGER STATUS] Session aktív (c_user & xs sütik érvényesek)!');
    }
    return finalValid;
  } catch (err) {
    console.warn(`⚠️ [MESSENGER CHECK HIBA] ${err.message}`);
    return false;
  }
}

/**
 * Exports all cookies + localStorage + IndexedDB (Messenger E2EE keys & Microsoft KCA tokens)
 * into a portable auth.json file ONLY IF Messenger is actually logged in (prevents overwriting good auth.json with logged-out state!).
 */
async function savePortableAuthState(context, force = false) {
  try {
    const validMessenger = await hasValidMessengerSession(context);
    if (!validMessenger && !force && fs.existsSync(AUTH_STATE_PATH)) {
      console.warn(
        '⚠️ [MENTÉS MEGTAGADVA] A Messenger jelenleg nincs belépve (hiányzik a c_user süti), ezért NEM írjuk felül a meglévő auth.json fájlt!'
      );
      return false;
    }

    await context.storageState({ path: AUTH_STATE_PATH, indexedDB: true });
    console.log(
      `💾 [MENTÉS KÉSZ] Hordozható belépési állapot (Messenger: ${validMessenger ? 'BELÉPVE ✅' : 'NINCS BELÉPVE ⚠️'}) elmentve ide: ${AUTH_STATE_PATH}`
    );
    return true;
  } catch (err) {
    try {
      await context.storageState({ path: AUTH_STATE_PATH });
      console.log(`💾 [MENTÉS KÉSZ] Sütik és localStorage elmentve ide: ${AUTH_STATE_PATH}`);
      return true;
    } catch (e2) {
      console.error(`❌ [MENTÉS HIBA] ${e2.message}`);
      return false;
    }
  }
}

/**
 * Restores cookies from auth.json into the persistent context if available.
 */
async function restorePortableAuthStateIfPresent(context) {
  if (!fs.existsSync(AUTH_STATE_PATH)) return;
  try {
    const state = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf-8'));
    if (Array.isArray(state.cookies) && state.cookies.length > 0) {
      await context.addCookies(state.cookies);
      const hasFbUser = state.cookies.some((c) => c.name === 'c_user');
      console.log(
        `🔑 [AUTH BETÖLTVE] ${state.cookies.length} süti betöltve az auth.json-ból (Messenger c_user süti: ${
          hasFbUser ? 'VAN ✅' : 'HIÁNYZIK ❌'
        })!`
      );
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
  console.log('  • status                              -> Ellenőrzi a belépett füleket és a Messenger sütiket');
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
      await savePortableAuthState(context, true);
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
      const fbValid = await hasValidMessengerSession(context);
      console.log(`📌 Messenger fül URL:    ${messengerPage.url()}`);
      console.log(`📌 Messenger Session:    ${fbValid ? '🟢 BELÉPVE (c_user & xs OK)' : '🔴 KIJELENTKEZVE!'}`);
      console.log(`📌 Moodle fül URL:       ${moodlePage.url()}`);
      console.log(`⏰ Órarend státusz:      ${currentSched.active ? '🟢 AKTÍV' : '🟡 ALVÓ MÓD'} (${currentSched.reason})`);
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
  await messengerPage.waitForTimeout(2500);
  await checkAndRecoverMessengerSession(context, messengerPage);

  console.log(`🎓 Moodle megnyitása: ${config.moodle_base_url}`);
  await moodlePage.goto(config.moodle_base_url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await ensureMoodleLoggedIn(moodlePage, config.moodle_base_url);

  setTimeout(() => savePortableAuthState(context), 15000);

  // Periodic health check on Messenger (every 2 minutes) + Moodle/KCA keep-alive (every 10 minutes)
  setInterval(async () => {
    try {
      await checkAndRecoverMessengerSession(context, messengerPage);
    } catch {}
  }, 2 * 60 * 1000);

  const keepAliveMs = (config.keep_alive_minutes || 10) * 60 * 1000;
  setInterval(async () => {
    try {
      if (!activeSubmissionPromise) {
        console.log('🔄 [KEEP-ALIVE] Moodle, KCA & Messenger session ellenőrzése...');
        await checkAndRecoverMessengerSession(context, messengerPage);
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
