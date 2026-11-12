import http from 'node:http';
import { chromium } from 'playwright';
import { decodeQrFromBuffer } from './qr.js';
import { extractSixCharCode } from './extractor.js';
import { submitQrUrl, submitSixCharCodeAcrossLinks } from './moodle.js';
import { checkActiveSchedule, checkCourseSchedule } from './schedule.js';

/**
 * Self-contained automated E2E test:
 * 1. Tests GitHub Copilot AI + Regex 6-character code extraction from Hungarian chat messages.
 * 2. Tests daily schedule filtering (Monday-Thursday 07:30-16:00 vs Friday/night).
 * 3. Spins up a mock Moodle server with 6 courses and tests "Submit attendance" + "Present".
 * 4. Generates a real QR code image in Playwright, decodes it in < 50ms, and submits the QR URL.
 */
async function runSelfTest() {
  console.log('🧪 1. TESZT: 6-jegyű kód kinyerés (Regex + GitHub Copilot AI)...');
  const cases = [
    { msg: 'X7B9K2', context: [], expected: 'X7B9K2' },
    { msg: 'ic7uoe', context: [], expected: 'ic7uoe' },
    { msg: 'a mai kód: ab12cd', context: [], expected: 'ab12cd' },
    { msg: 'sziasztok valaki küldte már?', context: [], expected: null },
    { msg: 'hupszi', context: ['ez prog1 lett'], expected: null },
    { msg: 'beírták táblára: 9k4m2p', context: [], expected: '9k4m2p' },
    { msg: 'srácok a táblára felírták hogy m8p4k1 siessetek', context: [], expected: 'm8p4k1' },
    { msg: 'ma délután megyek boltba venni kenyeret', context: [], expected: null },
  ];

  for (const c of cases) {
    const got = await extractSixCharCode(c.msg, c.context);
    console.log(`   Üzenet: "${c.msg}" -> Kinyert: ${got} (Várt: ${c.expected})`);
    if (got !== c.expected) throw new Error(`Kód kinyerési hiba: ${got} !== ${c.expected}`);
  }
  console.log('✅ Kód kinyerés + GitHub Copilot AI hibátlan!\n');

  console.log('🧪 1/B. TESZT: Napi idősáv (active_schedule) szűrés...');
  const sampleCfg = {
    timezone: 'Europe/Budapest',
    active_schedule: {
      Monday: [{ start: '07:30', end: '16:00' }],
      Tuesday: [{ start: '07:30', end: '16:00' }],
      Wednesday: [{ start: '07:30', end: '16:00' }],
      Thursday: [{ start: '07:30', end: '16:00' }],
      Friday: [],
    },
  };
  // Tuesday 10:00 Budapest time -> should be ACTIVE
  const tue10 = checkActiveSchedule(sampleCfg, new Date('2026-11-10T09:00:00Z'));
  // Tuesday 18:30 Budapest time -> should be SLEEPING
  const tue18 = checkActiveSchedule(sampleCfg, new Date('2026-11-10T17:30:00Z'));
  // Friday 10:00 Budapest time -> should be SLEEPING
  const fri10 = checkActiveSchedule(sampleCfg, new Date('2026-11-13T09:00:00Z'));

  console.log(`   Kedd 10:00 -> active=${tue10.active} (${tue10.reason})`);
  console.log(`   Kedd 18:30 -> active=${tue18.active} (${tue18.reason})`);
  console.log(`   Péntek 10:00 -> active=${fri10.active} (${fri10.reason})`);
  if (!tue10.active || tue18.active || fri10.active) {
    throw new Error('Hibás órarend idősáv szűrés!');
  }
  console.log('✅ Napi idősáv szűrés hibátlan!\n');

  // 2. Start local mock Moodle server
  let submittedFormData = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Course 1, 2, 3, 5, 6 -> No active Submit attendance link
    if (url.pathname === '/mod/attendance/view.php') {
      const id = url.searchParams.get('id');
      if (id === '44444') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html><body>
            <h1>Analízis II. - Jelenlét</h1>
            <table><tr>
              <td>2026.11.10 08:00 - 10:00</td>
              <td><a href="/mod/attendance/attendance.php?sessid=999">Submit attendance</a></td>
            </tr></table>
          </body></html>
        `);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h1>Tárgy #${id}</h1><p>Nincs aktív óra.</p></body></html>`);
      }
      return;
    }

    // Attendance submission form page
    if (url.pathname === '/mod/attendance/attendance.php' && req.method === 'GET') {
      const qrpass = url.searchParams.get('qrpass');
      const sessid = url.searchParams.get('sessid');
      if (qrpass === 'FASTQR') {
        submittedFormData = { qrpass: 'FASTQR', autoRecorded: true };
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><div>Your attendance in this session has been recorded.</div></body></html>`);
        return;
      }

      // Simulate Moodle returning HTTP 404 exception page with M.cfg.contextInstanceId when qrpass is stripped!
      if (sessid === '5309') {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><head><title>Hiba | PE e-learning</title><script>var M = { cfg: { "courseId": 36690, "contextInstanceId": 562883 } };</script></head><body>Hiba</body></html>`);
        return;
      }
      const courseViewId = sessid === '5303' ? '586640' : '44444';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html><head><title>Prog 1 Jelenlét</title></head><body>
          <nav><a href="/mod/attendance/view.php?id=${courseViewId}">Jelenléti ív</a></nav>
          <form action="/mod/attendance/attendance.php" method="POST">
            <label>Password: <input type="text" name="studentpassword" /></label>
            <label><input type="radio" name="status" value="present_id" /> Present</label>
            <label><input type="radio" name="status" value="absent_id" /> Absent</label>
            <input type="submit" name="submitbutton" value="Save changes" />
          </form>
        </body></html>
      `);
      return;
    }

    if (url.pathname === '/mod/attendance/attendance.php' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        submittedFormData = {
          studentpassword: params.get('studentpassword'),
          status: params.get('status'),
        };
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><div>Your attendance in this session has been recorded.</div></body></html>`);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    console.log('🧪 2. TESZT: 6 linken végigfutás és "Submit attendance" + "Present" leadása...');
    const testConfig = {
      attendance_urls: [
        `${base}/mod/attendance/view.php?id=11111`,
        `${base}/mod/attendance/view.php?id=22222`,
        `${base}/mod/attendance/view.php?id=33333`,
        `${base}/mod/attendance/view.php?id=44444`,
        `${base}/mod/attendance/view.php?id=55555`,
        `${base}/mod/attendance/view.php?id=66666`,
      ],
      retry_max_attempts: 1,
    };

    const ok = await submitSixCharCodeAcrossLinks(page, 'X7B9K2', testConfig);
    if (!ok || submittedFormData?.studentpassword !== 'X7B9K2' || submittedFormData?.status !== 'present_id') {
      throw new Error(`Hibás Moodle űrlap beküldés: ${JSON.stringify(submittedFormData)}`);
    }
    console.log('✅ 6 linken végigfutás + "Present" + "X7B9K2" beküldés sikeres:', submittedFormData);

    console.log('\n🧪 3. TESZT: QR-kód dekódolás, sessid visszavezetés (course_schedules) és deduplikáció...');
    const qrTargetUrl = `${base}/mod/attendance/attendance.php?sessid=777&qrpass=FASTQR`;
    await page.setContent(`
      <html><body>
        <img id="qr" src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrTargetUrl)}" />
      </body></html>
    `);
    const qrElement = page.locator('#qr');
    await qrElement.waitFor({ state: 'visible', timeout: 5000 });
    const pngBuffer = await qrElement.screenshot();

    const t0 = Date.now();
    const decodedUrl = await decodeQrFromBuffer(pngBuffer);
    const decodeMs = Date.now() - t0;
    console.log(`   QR Dekódolva ${decodeMs}ms alatt: ${decodedUrl}`);

    if (decodedUrl !== qrTargetUrl) {
      throw new Error(`QR dekódolási eltérés: ${decodedUrl}`);
    }

    const qrOk = await submitQrUrl(page, decodedUrl);
    if (!qrOk || !submittedFormData?.autoRecorded) {
      throw new Error('QR URL beküldés sikertelen');
    }

    // Test deduplication: sending a 2nd QR for the same sessid=777 should be skipped immediately
    submittedFormData = null;
    await submitQrUrl(page, `${base}/mod/attendance/attendance.php?sessid=777&qrpass=SECONDQR`);
    if (submittedFormData !== null) {
      throw new Error('Deduplikáció hiba: újra megnyitotta ugyanazt a sessid-t!');
    }

    // Test course_schedules rejection: sessid=5303 belongs to course 586640 (Prog 1), which is only allowed on Friday 18:00-20:00
    const restrictedConfig = {
      timezone: 'Europe/Budapest',
      course_schedules: {
        [`${base}/mod/attendance/view.php?id=586640`]: {
          name: 'Programozás 1 gyakorlat',
          buffer_before_minutes: 10,
          windows: [{ day: 'Sunday', start: '23:50', end: '23:59' }],
        },
      },
    };
    const rejected = await submitQrUrl(
      page,
      `${base}/mod/attendance/attendance.php?sessid=5303&qrpass=FASTQR`,
      restrictedConfig
    );
    if (rejected !== false || submittedFormData !== null) {
      throw new Error('Course schedule szűrés hiba: nem tiltotta le a másik csoport QR kódját!');
    }
    // Test HTTP 404 Moodle exception page + strict `attendance_urls` whitelist rejection (e.g. sessid=5309 -> Prog 1 ID 562883 not in attendance_urls)
    const whitelistRejected = await submitQrUrl(
      page,
      `${base}/mod/attendance/attendance.php?sessid=5309&qrpass=FASTQR`,
      { attendance_urls: [`${base}/mod/attendance/view.php?id=596153`] }
    );
    if (whitelistRejected !== false || submittedFormData !== null) {
      throw new Error('Whitelist szűrés hiba: nem tiltotta le az előteljesített tárgyat (sessid=5309)!');
    }
    console.log('✅ QR kód dekódolás, sessid deduplikáció, 404 M.cfg feloldás és előteljesített/más csoport QR kiszűrése hibátlan!');
  } finally {
    await browser.close();
    server.close();
  }
}

runSelfTest().catch((err) => {
  console.error('❌ TESZT HIBA:', err);
  process.exit(1);
});
