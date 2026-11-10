import { checkCourseSchedule } from './schedule.js';

/**
 * Handles Moodle Attendance submission for both:
 * 1. Fast QR Code URLs (<15s rotating token or direct qrpass link) with:
 *    - `sessid` deduplication (never submits the same session twice)
 *    - Pre-flight `sessid` -> Course resolution (`course_schedules` check BEFORE recording attendance!)
 *    - Instant priority (preempts any running 6-character code search)
 * 2. 6-character password scanning across configured course Attendance links (filtered by `course_schedules` + -10 min pre-class retry)
 * 3. Automatic KCA / Microsoft SSO session recovery if Moodle logs out
 */

const SUBMIT_LINK_SELECTORS = [
  'a:has-text("Submit attendance")',
  'a:has-text("Jelenlét rögzítése")',
  'a:has-text("Jelenlét leadása")',
  'a[href*="mod/attendance/attendance.php?sessid="]',
];

const PRESENT_LABELS = ['Present', 'Jelen', 'Jelenlévő', 'Anwesend', 'Részvétel'];

// Session deduplication & concurrency locks
const completedSessionIds = new Set();
const inFlightSessionIds = new Set();
const sessionToCourseCache = new Map(); // sessid -> { attendanceId, courseId, title }
let qrPreemptCount = 0; // > 0 whenever a high-priority QR submission is running

export function isQrRunning() {
  return qrPreemptCount > 0;
}

/**
 * Extracts the exact notification / alert / main status message shown on the Moodle page.
 */
async function inspectMoodlePageOutcome(page) {
  try {
    const info = await page.evaluate(() => {
      const heading =
        document.querySelector('#region-main h2, #region-main h1, .page-header-headings h1')?.innerText?.trim() || '';
      const alerts = [
        ...document.querySelectorAll(
          '.alert, .errormessage, .box.errorbox, .notification, [role="alert"], #user-notifications'
        ),
      ]
        .map((el) => el.innerText.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      const mainText = (
        document.querySelector('#region-main, [role="main"]')?.innerText ||
        document.body?.innerText ||
        ''
      )
        .replace(/További tájékoztatás erről a hibáról|More information about this error/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      return { heading, alerts, mainText: mainText.slice(0, 350) };
    });

    const combined = `${info.heading} | ${info.alerts.join(' | ')} | ${info.mainText}`;
    const cleanSummary =
      info.alerts.length > 0
        ? `${info.heading ? info.heading + ': ' : ''}${info.alerts.join(' | ')}`
        : info.mainText.slice(0, 180);

    if (/attendance in this session has been recorded|jelenléte.*rögzítve|sikeresen rögzít/i.test(combined)) {
      return { status: 'recorded', success: true, message: cleanSummary };
    }

    if (/nem módosíthat már rögzített jelenlétet|already.*recorded|cannot.*modify|már rögzített/i.test(combined)) {
      return { status: 'already_recorded', success: true, message: cleanSummary };
    }

    if (
      /incorrect|helytelen|hibás|invalid|expired|lejárt|nem érvényes|not allowed|nincs jogosultság|closed|lezárult/i.test(
        combined
      )
    ) {
      return { status: 'error', success: false, message: cleanSummary };
    }

    return { status: 'unknown', success: false, message: cleanSummary };
  } catch (err) {
    return { status: 'unknown', success: false, message: err.message };
  }
}

/**
 * Resolves which Moodle Attendance module (`view.php?id=...`) and Course (`course/view.php?id=...`)
 * a given `sessid` belongs to WITHOUT submitting `qrpass`!
 * Uses a fast background HTTP GET (`context.request.get`) with the browser's MoodleSession cookie (~100ms).
 */
async function resolveCourseFromSessId(moodlePage, qrUrl, sessId) {
  if (!sessId) return null;
  if (sessionToCourseCache.has(sessId)) {
    return sessionToCourseCache.get(sessId);
  }

  try {
    const parsed = new URL(qrUrl);
    // Probe URL has ONLY sessid (qrpass is stripped so Moodle does NOT record attendance yet!)
    const probeUrl = `${parsed.origin}${parsed.pathname}?sessid=${encodeURIComponent(sessId)}`;
    const response = await moodlePage.context().request.get(probeUrl, { timeout: 3500 });
    if (!response.ok()) return null;

    const html = await response.text();
    // Look for mod/attendance/view.php?id=XXXXX in breadcrumbs, form action, or cancel link
    const attMatches = [...html.matchAll(/mod\/attendance\/view\.php\?id=(\d+)/gi)].map((m) => m[1]);
    const courseMatches = [...html.matchAll(/course\/view\.php\?id=(\d+)/gi)].map((m) => m[1]);
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);

    const info = {
      attendanceId: attMatches[0] || null,
      courseId: courseMatches[0] || null,
      title: titleMatch ? titleMatch[1].trim() : '',
    };

    if (info.attendanceId || info.courseId) {
      sessionToCourseCache.set(sessId, info);
    }
    return info;
  } catch {
    return null;
  }
}

/**
 * Automatically detects if Moodle redirected to a login page and clicks through KCA / Microsoft SSO.
 */
export async function ensureMoodleLoggedIn(page, targetUrlAfterLogin = null) {
  try {
    const currentUrl = page.url();
    const isLoginPage =
      currentUrl.includes('/login/') ||
      currentUrl.includes('login.microsoftonline.com') ||
      (await page.locator('a[href*="auth/oidc"], a[href*="login/index.php"], .login-container').count()) > 0;

    if (!isLoginPage) return true;

    console.log('🔐 [KCA AUTO-LOGIN] Moodle bejelentkezési oldal észlelve, automatikus KCA/Microsoft beléptetés...');

    const kcaButtonSelectors = [
      'a[href*="auth/oidc"]',
      'a[href*="auth/oauth2"]',
      'a[href*="auth/shibboleth"]',
      'a:has-text("KCA")',
      'a:has-text("Microsoft")',
      'a:has-text("Office 365")',
      'a:has-text(" Központi ")',
      '.potentialidp a',
      'a[href*="/login/index.php"]',
    ];

    for (const sel of kcaButtonSelectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        console.log(`   -> Kattintás a belépés gombra: ${sel}`);
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {}),
          btn.click(),
        ]);
        break;
      }
    }

    if (page.url().includes('login.microsoftonline.com')) {
      await page.waitForTimeout(800);
      const accountTile = page
        .locator('div[data-test-id], .table[role="button"], div.tile-container div[role="listitem"]')
        .first();
      if ((await accountTile.count()) > 0 && (await accountTile.isVisible())) {
        console.log('   -> Microsoft fiók kiválasztása...');
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {}),
          accountTile.click(),
        ]);
      }

      const staySignedInBtn = page
        .locator('#idSIButton9, input[type="submit"][value="Yes"], input[type="submit"][value="Igen"]')
        .first();
      if ((await staySignedInBtn.count()) > 0 && (await staySignedInBtn.isVisible())) {
        console.log('   -> "Bejelentkezve marad? -> Igen" elfogadása...');
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {}),
          staySignedInBtn.click(),
        ]);
      }
    }

    if (targetUrlAfterLogin && !page.url().includes(targetUrlAfterLogin)) {
      await page.goto(targetUrlAfterLogin, { waitUntil: 'domcontentloaded', timeout: 10000 });
    }

    console.log('✅ [KCA AUTO-LOGIN] Sikeres visszalépés!');
    return true;
  } catch (err) {
    console.warn(`⚠️ [KCA AUTO-LOGIN] Hiba a visszaléptetés közben: ${err.message}`);
    return false;
  }
}

/**
 * Helper: On an open Moodle attendance.php form page, checks page status first,
 * or fills password (if needed), selects "Present" radio button (if present), and clicks Save.
 */
async function fillAttendanceFormIfPresent(page, code = null) {
  try {
    const initialOutcome = await inspectMoodlePageOutcome(page);
    if (initialOutcome.status === 'recorded') {
      return {
        success: true,
        status: 'recorded',
        detail: `Sikeresen rögzítve! Moodle válasz: "${initialOutcome.message}"`,
      };
    }
    if (initialOutcome.status === 'already_recorded') {
      return {
        success: true,
        status: 'already_recorded',
        detail: `Már korábban rögzítve volt! Moodle válasz: "${initialOutcome.message}"`,
      };
    }

    const submitBtn = page
      .locator(
        'input[name="submitbutton"], button[name="submitbutton"], form[action*="attendance.php"] input[type="submit"], form[action*="attendance.php"] button[type="submit"]'
      )
      .first();

    const hasForm = (await submitBtn.count()) > 0 && (await submitBtn.isVisible());

    if (!hasForm) {
      return {
        success: false,
        status: initialOutcome.status,
        detail: `Nincs kitölthető űrlap. Moodle üzenet: "${initialOutcome.message}"`,
      };
    }

    const passInput = page
      .locator(
        'input[name="studentpassword"], input[name="qrpass"], input#id_studentpassword, input[type="password"], input[name*="pass" i]'
      )
      .first();

    if (code && (await passInput.count()) > 0 && (await passInput.isVisible())) {
      await passInput.fill(code);
    }

    let radioSelected = false;
    for (const labelText of PRESENT_LABELS) {
      const label = page.locator(`label:has-text("${labelText}")`).first();
      if ((await label.count()) > 0) {
        await label.click();
        radioSelected = true;
        break;
      }
    }

    if (!radioSelected) {
      const firstStatusRadio = page
        .locator('input[type="radio"][name="status"], form[action*="attendance.php"] input[type="radio"]')
        .first();
      if ((await firstStatusRadio.count()) > 0) {
        await firstStatusRadio.check();
        radioSelected = true;
      }
    }

    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {}),
      submitBtn.click(),
    ]);

    const afterOutcome = await inspectMoodlePageOutcome(page);
    if (afterOutcome.status === 'error') {
      return {
        success: false,
        status: 'error',
        detail: `Sikertelen mentés! Moodle válasz: "${afterOutcome.message}"`,
      };
    }

    return {
      success: true,
      status: afterOutcome.status,
      detail: `Űrlap beküldve ("Present")! Moodle válasz: "${afterOutcome.message}"`,
    };
  } catch (err) {
    return { success: false, status: 'error', detail: `Hiba az űrlap kitöltésekor: ${err.message}` };
  }
}

/**
 * FAST PATH (< 1 sec) with Priority, Deduplication, and Course Schedule Verification!
 */
export async function submitQrUrl(moodlePage, qrUrl, config = {}) {
  const sessMatch = qrUrl.match(/[?&]sessid=(\d+)/i);
  const sessId = sessMatch ? sessMatch[1] : null;

  // 1. Deduplication check: if this sessid was already recorded or is currently being opened, skip immediately!
  if (sessId && completedSessionIds.has(sessId)) {
    console.log(
      `⏭️ [QR DEDUPE] A(z) sessid=${sessId} órára már rögzítve van a jelenléted, további QR kód átugrása!`
    );
    return true;
  }
  if (sessId && inFlightSessionIds.has(sessId)) {
    console.log(`⏭️ [QR DEDUPE] A(z) sessid=${sessId} megnyitása már folyamatban van, duplikált kérés átugrása!`);
    return true;
  }

  if (sessId) inFlightSessionIds.add(sessId);
  qrPreemptCount++;

  const t0 = Date.now();
  try {
    // 2. If `course_schedules` is configured, resolve which course `sessid` belongs to BEFORE opening `qrpass`!
    if (
      sessId &&
      config.course_schedules &&
      Object.keys(config.course_schedules).length > 0
    ) {
      const courseInfo = await resolveCourseFromSessId(moodlePage, qrUrl, sessId);
      if (courseInfo && (courseInfo.attendanceId || courseInfo.courseId)) {
        const checkId = courseInfo.attendanceId || courseInfo.courseId;
        const courseCheck = checkCourseSchedule(config, checkId);
        if (!courseCheck.allowed) {
          console.log(
            `\n🛑 [QR SKIPPELVE - MÁS CSOPORT ÓRÁJA!] sessid=${sessId} -> Tárgy ID: ${checkId} (${
              courseInfo.title || ''
            })\n   Indok: ${courseCheck.reason}`
          );
          // Mark sessId as handled so subsequent QR photos from that other group's class are also ignored in 0ms
          completedSessionIds.add(sessId);
          return false;
        } else if (courseCheck.courseName) {
          console.log(`✅ [CSOPORT ELLENŐRZÉS OK] ${courseCheck.reason}`);
        }
      }
    }

    console.log(`\n⚡ [QR-GYORSÍTÓ] Link megnyitása: ${qrUrl}`);
    await moodlePage.goto(qrUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
    await ensureMoodleLoggedIn(moodlePage, qrUrl);

    const urlCodeMatch = qrUrl.match(/[?&](?:qrpass|studentpassword|pass)=([^&]+)/i);
    const extractedCode = urlCodeMatch ? decodeURIComponent(urlCodeMatch[1]) : null;

    const res = await fillAttendanceFormIfPresent(moodlePage, extractedCode);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    if (res.status === 'already_recorded') {
      if (sessId) completedSessionIds.add(sessId);
      console.log(`ℹ️ [QR Megerősítve - ${elapsed}s] ${res.detail}`);
    } else if (res.success) {
      if (sessId) completedSessionIds.add(sessId);
      console.log(`✅ [QR SIKER - ${elapsed}s] ${res.detail}`);
    } else {
      console.warn(`⚠️ [QR ELUTASÍTVA / HIBA - ${elapsed}s] ${res.detail}`);
    }
    return res.success;
  } catch (err) {
    console.error(`❌ [QR HIBA] Nem sikerült megnyitni a QR linket: ${err.message}`);
    return false;
  } finally {
    if (sessId) inFlightSessionIds.delete(sessId);
    qrPreemptCount = Math.max(0, qrPreemptCount - 1);
  }
}

/**
 * 6-CHAR CODE PATH: Loops through configured attendance_urls (skipping courses outside their `course_schedules` window!).
 * Automatically yields/pauses if a high-priority QR code arrives mid-scan!
 */
export async function submitSixCharCodeAcrossLinks(moodlePage, code, config) {
  const urls = (config.attendance_urls || []).filter(
    (u) => u && !u.includes('moodle.egyetem.hu')
  );

  if (urls.length === 0) {
    console.warn(
      `⚠️ [MOODLE] Kód észlelve (${code}), de még a minta linkek vannak a config.json-ban! Írd át a saját tárgyaid linkjére.`
    );
    return false;
  }

  const maxAttempts = config.retry_max_attempts || 35;
  const retryWaitMs = (config.retry_if_not_open_seconds || 20) * 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Filter out courses that have a restricted group schedule in `course_schedules` and aren't currently active
    const eligibleUrls = [];
    for (const u of urls) {
      const check = checkCourseSchedule(config, u);
      if (check.allowed) {
        eligibleUrls.push(u);
      } else if (attempt === 1) {
        console.log(`⏭️ [TÁRGY KIHAGYVA] ${u} -> ${check.reason}`);
      }
    }

    if (eligibleUrls.length === 0) {
      console.log(`⏸️ [NINCS AKTÍV TÁRGY] Jelenleg egyik tárgyad sincs a megengedett csoport-idősávban.`);
      return false;
    }

    console.log(
      `\n🔍 [KÓD KERESÉS #${attempt}/${maxAttempts}] "${code}" próbálása ${eligibleUrls.length} tárgy linken...`
    );

    for (const courseUrl of eligibleUrls) {
      // Yield immediately if a fast QR code arrived!
      while (isQrRunning()) {
        console.log('⚡ [PRIORITÁS] 6-jegyű kód keresés szüneteltetése, amíg a QR-kód lefut...');
        await new Promise((r) => setTimeout(r, 400));
      }

      try {
        await moodlePage.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await ensureMoodleLoggedIn(moodlePage, courseUrl);

        let submitLink = null;
        for (const sel of SUBMIT_LINK_SELECTORS) {
          const loc = moodlePage.locator(sel).first();
          if ((await loc.count()) > 0 && (await loc.isVisible())) {
            submitLink = loc;
            break;
          }
        }

        if (submitLink) {
          const href = await submitLink.getAttribute('href');
          const sessMatch = href?.match(/[?&]sessid=(\d+)/i);
          const sessId = sessMatch ? sessMatch[1] : null;

          if (sessId && completedSessionIds.has(sessId)) {
            console.log(`ℹ️ [MÁR RÖGZÍTVE] A(z) ${courseUrl} (sessid=${sessId}) órára már be vagy írva!`);
            return true;
          }

          console.log(`🎯 [TALÁLAT] Aktív jelenlét űrlap megtalálva itt: ${courseUrl}`);

          await Promise.all([
            moodlePage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {}),
            submitLink.click(),
          ]);

          const res = await fillAttendanceFormIfPresent(moodlePage, code);
          if (res.success) {
            if (sessId) completedSessionIds.add(sessId);
            console.log(`🎉 [SIKER] "${code}" -> ${res.detail}`);
            return true;
          } else {
            console.warn(`⚠️ [FIGYELEM] Űrlap megvolt, de: ${res.detail} (${href})`);
          }
        }
      } catch (err) {
        console.warn(`⚠️ [LINK HIBA] ${courseUrl}: ${err.message}`);
      }
    }

    if (attempt < maxAttempts) {
      console.log(
        `⏳ [BUFFER VÁRAKOZÁS] Még egyik tárgyon sincs nyitva a "Submit attendance" gomb (pl. óra előtt vagyunk). Újrapróbálás ${
          retryWaitMs / 1000
        } mp múlva...`
      );
      await new Promise((r) => setTimeout(r, retryWaitMs));
    }
  }

  console.error(`❌ [LEJÁRT] Nem nyílt meg jelenlét űrlap a(z) "${code}" kódhoz.`);
  return false;
}
