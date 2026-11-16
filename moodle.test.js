import assert from 'node:assert/strict';
import test from 'node:test';
import { submitQrUrl, submitSixCharCodeAcrossLinks } from './moodle.js';

const base = 'https://moodle.example.test';
const courseUrl = (id) => `${base}/mod/attendance/view.php?id=${id}`;
const qrUrl = (sessid) => `${base}/mod/attendance/attendance.php?sessid=${sessid}&qrpass=ABC123`;

function mockMoodle(courses, outcomes = ['Your attendance in this session has been recorded.']) {
  let url = 'about:blank';
  let view = 'blank';
  let session = null;
  let password = '';
  let outcome = '';
  let submissions = 0;
  const submitted = [];

  const page = {
    context: () => ({
      request: {
        get: async (probeUrl) => {
          const id = new URL(probeUrl).searchParams.get('sessid');
          const course = courses.find((item) => item.session === id);
          return { text: async () => `<a href="/mod/attendance/view.php?id=${course.id}">course</a>` };
        },
      },
    }),
    url: () => url,
    goto: async (target) => {
      url = target;
      const parsed = new URL(target);
      if (parsed.pathname.endsWith('/view.php')) {
        session = courses.find((item) => item.id === parsed.searchParams.get('id'))?.session;
        view = 'course';
      } else {
        session = parsed.searchParams.get('sessid');
        view = 'form';
      }
    },
    evaluate: async (fn) => {
      if (fn.toString().includes('window.M')) return false;
      return { heading: '', alerts: [], mainText: view === 'outcome' ? outcome : '' };
    },
    waitForLoadState: async () => {},
    locator: (selector) => {
      let exists = false;
      let click = async () => {};
      let href = null;
      if (selector.startsWith('a:has-text("Submit attendance")') && view === 'course' && session) {
        exists = true;
        href = `/mod/attendance/attendance.php?sessid=${session}`;
        click = async () => { view = 'form'; };
      } else if (selector.startsWith('input[name="submitbutton"]') && view === 'form') {
        exists = true;
        click = async () => {
          submitted.push({ session, password });
          outcome = outcomes[Math.min(submissions++, outcomes.length - 1)];
          view = 'outcome';
        };
      } else if (selector.startsWith('input[name="studentpassword"]') && view === 'form') {
        exists = true;
      } else if (selector.startsWith('label:has-text("Present")') && view === 'form') {
        exists = true;
      }
      return {
        first() { return this; },
        count: async () => Number(exists),
        isVisible: async () => exists,
        getAttribute: async () => href,
        fill: async (value) => { password = value; },
        click,
      };
    },
  };
  return { page, submitted };
}

test('a whitelist miatt kihagyott QR nem akadályozza a későbbi kód leadását', async () => {
  const { page, submitted } = mockMoodle([{ id: '101', session: '9101' }]);
  assert.equal(await submitQrUrl(page, qrUrl('9101'), { attendance_urls: [courseUrl('102')] }), false);
  assert.equal(await submitSixCharCodeAcrossLinks(page, 'AB12CD', {
    attendance_urls: [courseUrl('101')], retry_max_attempts: 1,
  }), true);
  assert.deepEqual(submitted, [{ session: '9101', password: 'AB12CD' }]);
});

test('az órarend miatt kihagyott QR később újra feldolgozható', async () => {
  const { page, submitted } = mockMoodle([{ id: '103', session: '9103' }]);
  const today = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Budapest', weekday: 'long' }).format(new Date());
  const otherDay = today === 'Monday' ? 'Tuesday' : 'Monday';
  assert.equal(await submitQrUrl(page, qrUrl('9103'), {
    attendance_urls: [courseUrl('103')],
    course_schedules: { [courseUrl('103')]: { windows: [{ day: otherDay, start: '08:00', end: '10:00' }] } },
  }), false);
  assert.equal(await submitQrUrl(page, qrUrl('9103'), { attendance_urls: [courseUrl('103')] }), true);
  assert.deepEqual(submitted, [{ session: '9103', password: 'ABC123' }]);
});

test('a nem megerősített mentés nem számít sikernek és újrapróbálható', async () => {
  const { page, submitted } = mockMoodle([{ id: '104', session: '9104' }], [
    'Ismeretlen válasz', 'Your attendance in this session has been recorded.',
  ]);
  const config = { attendance_urls: [courseUrl('104')], retry_max_attempts: 1 };
  assert.equal(await submitSixCharCodeAcrossLinks(page, 'AB12CD', config), false);
  assert.equal(await submitSixCharCodeAcrossLinks(page, 'AB12CD', config), true);
  assert.equal(submitted.length, 2);
});

test('a korábban megerősített alkalom után más tárgyak keresése folytatódik', async () => {
  const { page, submitted } = mockMoodle([
    { id: '105', session: '9105' }, { id: '106', session: '9106' },
  ]);
  assert.equal(await submitSixCharCodeAcrossLinks(page, 'AB12CD', {
    attendance_urls: [courseUrl('105')], retry_max_attempts: 1,
  }), true);
  assert.equal(await submitSixCharCodeAcrossLinks(page, 'XY12ZZ', {
    attendance_urls: [courseUrl('105'), courseUrl('106')], retry_max_attempts: 1,
  }), true);
  assert.deepEqual(submitted, [
    { session: '9105', password: 'AB12CD' }, { session: '9106', password: 'XY12ZZ' },
  ]);
});
