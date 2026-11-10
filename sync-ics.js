import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const AUTH_PATH = path.join(__dirname, 'auth.json');
const ICS_CACHE_PATH = path.join(__dirname, '.neptun-calendar.ics');

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Parses an iCalendar (.ics) UTC timestamp like "20260907T100000Z" into a JS Date object.
 */
export function parseIcsDate(icsStr) {
  if (!icsStr) return null;
  const clean = icsStr.trim();
  const m = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  if (m[7] === 'Z') {
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/**
 * Formats a Date into { dateStr: "YYYY-MM-DD", weekday: "Monday", timeStr: "HH:MM", minutes: number }
 * in the target timezone (default: Europe/Budapest).
 */
export function formatInTimeZone(date, timeZone = 'Europe/Budapest') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const weekday = get('weekday');
  const hour = get('hour') === '24' ? '00' : get('hour');
  const minute = get('minute');
  const timeStr = `${hour}:${minute}`;
  const minutes = Number(hour) * 60 + Number(minute);

  return {
    dateStr: `${year}-${month}-${day}`,
    weekday,
    timeStr,
    minutes,
  };
}

function minutesToHHMM(min) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, min));
  const h = String(Math.floor(clamped / 60)).padStart(2, '0');
  const m = String(clamped % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Normalizes a course name for comparison between Neptun SUMMARY and Moodle course fullname
 */
export function normalizeCourseTitle(raw) {
  if (!raw) return '';
  return raw
    .split('(')[0]
    .split('[')[0]
    .split(' - ')[0]
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/nappali tagozatos.*/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses raw .ics text into an array of class events.
 */
export function parseNeptunIcsEvents(icsText, timeZone = 'Europe/Budapest') {
  const blocks = icsText.split('BEGIN:VEVENT').slice(1);
  const events = [];

  for (const block of blocks) {
    const summaryRaw = block.match(/SUMMARY:(.+)/)?.[1]?.trim() || '';
    const location = block.match(/LOCATION:(.+)/)?.[1]?.trim() || '';
    const dtStartRaw = block.match(/DTSTART(?:;[^:]+)?:(.+)/)?.[1]?.trim() || '';
    const dtEndRaw = block.match(/DTEND(?:;[^:]+)?:(.+)/)?.[1]?.trim() || '';

    const startDate = parseIcsDate(dtStartRaw);
    const endDate = parseIcsDate(dtEndRaw);
    if (!summaryRaw || !startDate || !endDate) continue;

    const courseName = summaryRaw.split('(')[0].replace(/\s+/g, ' ').trim();
    const startFmt = formatInTimeZone(startDate, timeZone);
    const endFmt = formatInTimeZone(endDate, timeZone);

    events.push({
      summary: summaryRaw,
      courseName,
      normalizedName: normalizeCourseTitle(courseName),
      location,
      startDate,
      endDate,
      dateStr: startFmt.dateStr,
      day: startFmt.weekday,
      start: startFmt.timeStr,
      end: endFmt.timeStr,
      startMinutes: startFmt.minutes,
      endMinutes: endFmt.minutes,
    });
  }

  return events;
}

/**
 * Fetches the Moodle course title for each URL in `config.attendance_urls` using saved cookies in `auth.json`.
 */
async function fetchMoodleCourseTitles(attendanceUrls) {
  const result = new Map();
  if (!fs.existsSync(AUTH_PATH)) return result;

  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
    const cookieHeader = (auth.cookies || [])
      .filter((c) => c.domain && c.domain.includes('uni-pannon.hu'))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    if (!cookieHeader) return result;

    for (const url of attendanceUrls) {
      try {
        const res = await fetch(url, { headers: { Cookie: cookieHeader } });
        const html = await res.text();
        const cfgMatch = html.match(/"courseId"\s*:\s*(\d+)/);
        const instMatch = html.match(/"contextInstanceId"\s*:\s*(\d+)/);
        const code = html.match(/<title>([^:]+):/i)?.[1]?.trim()?.split('/')[0]?.replace(/_H$/, '');

        let fullTitle = '';
        if (code) {
          const regex = new RegExp(`([^"<>]+\\(${code}[^"<>]*\\))`, 'i');
          fullTitle = html.match(regex)?.[1]?.replace(/\s+/g, ' ')?.trim() || '';
        }
        if (!fullTitle && cfgMatch) {
          const cRes = await fetch(`https://moodle.uni-pannon.hu/course/view.php?id=${cfgMatch[1]}`, {
            headers: { Cookie: cookieHeader },
          });
          const cHtml = await cRes.text();
          fullTitle = cHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '')?.trim() || '';
        }

        if (fullTitle) {
          result.set(url, {
            attendanceId: instMatch ? instMatch[1] : url.match(/id=(\d+)/)?.[1],
            courseId: cfgMatch ? cfgMatch[1] : null,
            courseName: fullTitle.split('(')[0].replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim(),
            fullTitle,
            normalizedName: normalizeCourseTitle(fullTitle),
          });
        }
      } catch {}
    }
  } catch {}

  return result;
}

/**
 * Downloads the Neptun .ics calendar, caches it locally to `.neptun-calendar.ics`,
 * and automatically builds:
 * - `active_schedule` & `course_schedules` ONLY for courses present in `config.attendance_urls` (if Moodle titles can be fetched),
 *   so pre-completed courses omitted from `attendance_urls` (e.g. Prog 1 / Prog alap) are automatically excluded!
 * - If run without `auth.json` (offline/other user before login), exports all courses from the .ics by name.
 */
export async function syncNeptunIcsToConfig(icsUrlInput, bufferBeforeMinutes = 15) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const icsUrl = icsUrlInput || cfg.neptun_ics_url;
  if (!icsUrl) {
    throw new Error('Nincs megadva Neptun .ics URL!');
  }

  console.log(`📥 Neptun órarend (.ics) letöltése...\n   URL: ${icsUrl.slice(0, 85)}...`);
  const res = await fetch(icsUrl);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} hiba az .ics letöltésekor`);
  }

  const icsText = await res.text();
  if (!icsText.includes('BEGIN:VCALENDAR')) {
    throw new Error('A letöltött fájl nem érvényes iCalendar (.ics) formátumú!');
  }

  fs.writeFileSync(ICS_CACHE_PATH, icsText, 'utf-8');

  const timeZone = cfg.timezone || 'Europe/Budapest';
  const events = parseNeptunIcsEvents(icsText, timeZone);
  console.log(`✅ ${events.length} db órarendi esemény (VEVENT) beolvasva a Neptunból!`);

  const courseMap = new Map();
  for (const ev of events) {
    if (!courseMap.has(ev.courseName)) {
      courseMap.set(ev.courseName, {
        courseName: ev.courseName,
        normalizedName: ev.normalizedName,
        slots: new Map(),
      });
    }
    const entry = courseMap.get(ev.courseName);
    const slotKey = `${ev.day}|${ev.start}|${ev.end}`;
    if (!entry.slots.has(slotKey)) {
      entry.slots.set(slotKey, {
        day: ev.day,
        start: ev.start,
        end: ev.end,
        dates: new Set(),
      });
    }
    entry.slots.get(slotKey).dates.add(ev.dateStr);
  }

  console.log('\n🔍 Moodle `attendance_urls` tárgyak párosítása a Neptun órarenddel...');
  const moodleTitles = await fetchMoodleCourseTitles(cfg.attendance_urls || []);
  const hasMoodleAuth = moodleTitles.size > 0;

  const newCourseSchedules = {};
  const dayMinMax = new Map();

  for (const [neptunName, cData] of courseMap) {
    let matchedMoodleUrl = null;
    for (const [mUrl, mInfo] of moodleTitles.entries()) {
      const mNorm = mInfo.normalizedName;
      const cNorm = cData.normalizedName;
      if (
        mNorm === cNorm ||
        mNorm.startsWith(cNorm + ' ') ||
        cNorm.startsWith(mNorm + ' ')
      ) {
        matchedMoodleUrl = mUrl;
        break;
      }
    }

    // If we know the user's Moodle attendance_urls titles, skip courses that the user deliberately omitted from attendance_urls!
    if (hasMoodleAuth && !matchedMoodleUrl) {
      console.log(`   ⏭️  ${neptunName.padEnd(42)} -> Kihagyva (nincs benne az attendance_urls listádban)`);
      continue;
    }

    const windows = [...cData.slots.values()].map((s) => {
      const totalOccurrences = s.dates.size;
      const isBiWeeklyOrCustom = totalOccurrences < 12; // e.g. 7x in semester = A/B week!
      return {
        day: s.day,
        start: s.start,
        end: s.end,
        ...(isBiWeeklyOrCustom
          ? {
              note: `A/B hetes vagy egyedi alkalmak (${totalOccurrences}x a félévben)`,
              dates: [...s.dates].sort(),
            }
          : {}),
      };
    });

    const scheduleKey = matchedMoodleUrl || neptunName;
    newCourseSchedules[scheduleKey] = {
      name: neptunName,
      buffer_before_minutes: bufferBeforeMinutes,
      windows,
    };

    // Update daily active_schedule ONLY from active courses!
    for (const [, slot] of cData.slots) {
      if (slot.dates.size < 3) continue;
      const [sh, sm] = slot.start.split(':').map(Number);
      const [eh, em] = slot.end.split(':').map(Number);
      const sMin = sh * 60 + sm - 30;
      const eMin = eh * 60 + em;

      const cur = dayMinMax.get(slot.day) || { minStart: 24 * 60, maxEnd: 0 };
      cur.minStart = Math.min(cur.minStart, sMin);
      cur.maxEnd = Math.max(cur.maxEnd, eMin);
      dayMinMax.set(slot.day, cur);
    }

    const winStr = windows
      .map((w) => `${w.day} ${w.start}-${w.end}${w.dates ? ` [${w.dates.length} alkalom - A/B hét]` : ''}`)
      .join(', ');
    console.log(
      `   ✅ ${neptunName.padEnd(42)} -> ${matchedMoodleUrl ? `Moodle ID=${matchedMoodleUrl.split('id=')[1]}` : neptunName} | ${winStr}`
    );
  }

  const newActiveSchedule = {};
  for (const d of DAY_NAMES) {
    if (dayMinMax.has(d)) {
      const { minStart, maxEnd } = dayMinMax.get(d);
      newActiveSchedule[d] = [{ start: minutesToHHMM(minStart), end: minutesToHHMM(maxEnd) }];
    } else {
      newActiveSchedule[d] = [];
    }
  }

  cfg.neptun_ics_url = icsUrl;
  cfg.active_schedule = newActiveSchedule;
  cfg.course_schedules = newCourseSchedules;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  console.log(`\n🎉 [ÓRAREND EXPORT KÉSZ] A config.json automatikusan frissítve a Neptun .ics alapján (A/B hetes dátumokkal együtt)!`);
  return cfg;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argUrl = process.argv[2];
  syncNeptunIcsToConfig(argUrl).catch((err) => {
    console.error('❌ Hiba az .ics szinkronizálásakor:', err.message);
    process.exit(1);
  });
}
