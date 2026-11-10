/**
 * Handles Moodle Attendance submission for both:
 * 1. Fast QR Code URLs (<15s rotating token or direct qrpass link)
 * 2. 6-character password scanning across the configured course Attendance links (with -10 min pre-class retry support)
 * 3. Automatic KCA / Microsoft SSO session recovery if Moodle logs out
 */

// Labels for the "Submit attendance" link in Moodle (English & Hungarian & German)
const SUBMIT_LINK_SELECTORS = [
  'a:has-text("Submit attendance")',
  'a:has-text("Jelenlét rögzítése")',
  'a:has-text("Jelenlét leadása")',
  'a[href*="mod/attendance/attendance.php?sessid="]',
];

// Labels for the "Present" radio button in Moodle (English & Hungarian)
const PRESENT_LABELS = ['Present', 'Jelen', 'Jelenlévő', 'Anwesend'];

/**
 * Extracts the exact notification / alert / main status message shown on the Moodle page
 * so you always see Moodle's real response in the console.
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
    const cleanSummary = info.alerts.length > 0
      ? `${info.heading ? info.heading + ': ' : ''}${info.alerts.join(' | ')}`
      : info.mainText.slice(0, 180);

    // 1. Freshly recorded attendance
    if (
      /attendance in this session has been recorded|jelenléte.*rögzítve|sikeresen rögzít/i.test(combined)
    ) {
      return { status: 'recorded', success: true, message: cleanSummary };
    }

    // 2. Already recorded earlier ("Nem módosíthat már rögzített jelenlétet")
    if (
      /nem módosíthat már rögzített jelenlétet|already.*recorded|cannot.*modify|már rögzített/i.test(combined)
    ) {
      return { status: 'already_recorded', success: true, message: cleanSummary };
    }

    // 3. Expired / Invalid QR or password / Closed session
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
 * Automatically detects if Moodle redirected to a login page (/login/index.php, auth/oidc, KCA, or Microsoft account picker)
 * and clicks through KCA / Microsoft SSO using the persistent session cookies.
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
      const accountTile = page.locator('div[data-test-id], .table[role="button"], div.tile-container div[role="listitem"]').first();
      if ((await accountTile.count()) > 0 && (await accountTile.isVisible())) {
        console.log('   -> Microsoft fiók kiválasztása...');
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {}),
          accountTile.click(),
        ]);
      }

      const staySignedInBtn = page.locator('#idSIButton9, input[type="submit"][value="Yes"], input[type="submit"][value="Igen"]').first();
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
    // 1. Inspect what Moodle immediately returned upon opening the URL
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

    // 2. Check if there is an attendance form on the page
    const submitBtn = page.locator(
      'input[name="submitbutton"], button[name="submitbutton"], form[action*="attendance.php"] input[type="submit"], form[action*="attendance.php"] button[type="submit"]'
    ).first();

    const hasForm = (await submitBtn.count()) > 0 && (await submitBtn.isVisible());

    if (!hasForm) {
      // No form on page -> return the exact message Moodle showed (e.g. expired QR / error box)
      return {
        success: false,
        status: initialOutcome.status,
        detail: `Nincs kitölthető űrlap. Moodle üzenet: "${initialOutcome.message}"`,
      };
    }

    // 3. Fill password input field if present
    const passInput = page.locator(
      'input[name="studentpassword"], input[name="qrpass"], input#id_studentpassword, input[type="password"], input[name*="pass" i]'
    ).first();

    if (code && (await passInput.count()) > 0 && (await passInput.isVisible())) {
      await passInput.fill(code);
    }

    // 4. Select "Present" / "Jelen" radio option
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
      const firstStatusRadio = page.locator(
        'input[type="radio"][name="status"], form[action*="attendance.php"] input[type="radio"]'
      ).first();
      if ((await firstStatusRadio.count()) > 0) {
        await firstStatusRadio.check();
        radioSelected = true;
      }
    }

    // 5. Click Save and inspect Moodle's response page
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
 * FAST PATH (< 1 sec): Opens a decoded QR URL in the authenticated Moodle tab and verifies Moodle's response.
 */
export async function submitQrUrl(moodlePage, qrUrl) {
  const t0 = Date.now();
  console.log(`\n⚡ [QR-GYORSÍTÓ] Link megnyitása: ${qrUrl}`);
  try {
    await moodlePage.goto(qrUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
    await ensureMoodleLoggedIn(moodlePage, qrUrl);

    const urlCodeMatch = qrUrl.match(/[?&](?:qrpass|studentpassword|pass)=([^&]+)/i);
    const extractedCode = urlCodeMatch ? decodeURIComponent(urlCodeMatch[1]) : null;

    const res = await fillAttendanceFormIfPresent(moodlePage, extractedCode);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    if (res.status === 'already_recorded') {
      console.log(`ℹ️ [QR Megerősítve - ${elapsed}s] ${res.detail}`);
    } else if (res.success) {
      console.log(`✅ [QR SIKER - ${elapsed}s] ${res.detail}`);
    } else {
      console.warn(`⚠️ [QR ELUTASÍTVA / HIBA - ${elapsed}s] ${res.detail}`);
    }
    return res.success;
  } catch (err) {
    console.error(`❌ [QR HIBA] Nem sikerült megnyitni a QR linket: ${err.message}`);
    return false;
  }
}

/**
 * 6-CHAR CODE PATH: Loops through all configured attendance_urls to find the active "Submit attendance" button.
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
    console.log(
      `\n🔍 [KÓD KERESÉS #${attempt}/${maxAttempts}] "${code}" próbálása ${urls.length} tárgy linken...`
    );

    for (const courseUrl of urls) {
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
          console.log(`🎯 [TALÁLAT] Aktív jelenlét űrlap megtalálva itt: ${courseUrl}`);

          await Promise.all([
            moodlePage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {}),
            submitLink.click(),
          ]);

          const res = await fillAttendanceFormIfPresent(moodlePage, code);
          if (res.success) {
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
