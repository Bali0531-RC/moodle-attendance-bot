const DAY_MAP = {
  // English (full & short)
  monday: 'Monday', mon: 'Monday',
  tuesday: 'Tuesday', tue: 'Tuesday',
  wednesday: 'Wednesday', wed: 'Wednesday',
  thursday: 'Thursday', thu: 'Thursday',
  friday: 'Friday', fri: 'Friday',
  saturday: 'Saturday', sat: 'Saturday',
  sunday: 'Sunday', sun: 'Sunday',
  // Hungarian
  'hétfő': 'Monday', hetfo: 'Monday',
  kedd: 'Tuesday',
  szerda: 'Wednesday',
  'csütörtök': 'Thursday', csutortok: 'Thursday',
  'péntek': 'Friday', pentek: 'Friday',
  szombat: 'Saturday',
  'vasárnap': 'Sunday', vasarnap: 'Sunday',
};

function parseTimeToMinutes(hhmm) {
  const [h, m] = String(hhmm).trim().split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function getCurrentTimeParts(config, now = new Date()) {
  const timeZone = config.timezone || 'Europe/Budapest';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const weekdayRaw = parts.find((p) => p.type === 'weekday')?.value || 'Monday';
  const hourStr = parts.find((p) => p.type === 'hour')?.value || '00';
  const minuteStr = parts.find((p) => p.type === 'minute')?.value || '00';
  const currentTime = `${hourStr === '24' ? '00' : hourStr}:${minuteStr}`;
  const currentMinutes = parseTimeToMinutes(currentTime);

  return { weekdayRaw, currentTime, currentMinutes };
}

/**
 * Checks if the current time (or a given Date) falls inside any of the configured
 * daily time windows in `config.active_schedule`.
 */
export function checkActiveSchedule(config, now = new Date()) {
  const schedule = config.active_schedule;

  if (!schedule || Object.keys(schedule).length === 0) {
    return { active: true, dayName: 'All', currentTime: '', reason: 'Nincs időkorlát beállítva' };
  }

  const { weekdayRaw, currentTime, currentMinutes } = getCurrentTimeParts(config, now);

  let dayWindows = [];
  for (const [key, val] of Object.entries(schedule)) {
    const normalizedDay = DAY_MAP[key.toLowerCase().trim()] || key;
    if (normalizedDay.toLowerCase() === weekdayRaw.toLowerCase() && Array.isArray(val)) {
      dayWindows = val;
      break;
    }
  }

  if (!dayWindows || dayWindows.length === 0) {
    return {
      active: false,
      dayName: weekdayRaw,
      currentTime,
      reason: `${weekdayRaw} (${currentTime}) - erre a napra nincs aktív idősáv beállítva`,
    };
  }

  for (const win of dayWindows) {
    if (!win.start || !win.end) continue;
    const startMin = parseTimeToMinutes(win.start);
    const endMin = parseTimeToMinutes(win.end);
    if (currentMinutes >= startMin && currentMinutes <= endMin) {
      return {
        active: true,
        dayName: weekdayRaw,
        currentTime,
        reason: `Aktív idősávban (${weekdayRaw} ${win.start} - ${win.end}, most: ${currentTime})`,
      };
    }
  }

  const rangesStr = dayWindows.map((w) => `${w.start}-${w.end}`).join(', ');
  return {
    active: false,
    dayName: weekdayRaw,
    currentTime,
    reason: `Idősávon kívül (${weekdayRaw} ${currentTime}, engedélyezve: ${rangesStr})`,
  };
}

/**
 * Extracts all course/attendance IDs from an attendance URL or course URL
 * e.g. "https://moodle.uni-pannon.hu/mod/attendance/view.php?id=586640" -> "586640"
 */
export function extractUrlId(urlOrId) {
  if (!urlOrId) return '';
  const str = String(urlOrId).trim();
  if (/^\d+$/.test(str)) return str;
  const match = str.match(/[?&]id=(\d+)/i);
  return match ? match[1] : str;
}

/**
 * Checks if a specific course (identified by its attendance URL, course URL, or numeric ID)
 * has optional time-window restrictions in `config.course_schedules`.
 *
 * - If the course is NOT listed in `config.course_schedules` (or has an empty windows array),
 *   it returns `{ allowed: true }` (no restriction for that course).
 * - If the course IS listed in `config.course_schedules`, it checks whether `now` is within
 *   `[start - buffer_before_minutes, end]` (default buffer: 10 minutes before class).
 */
export function checkCourseSchedule(config, courseIdentifier, now = new Date()) {
  const courseSchedules = config.course_schedules;
  if (!courseSchedules || Object.keys(courseSchedules).length === 0 || !courseIdentifier) {
    return { allowed: true, reason: 'Nincs tárgy-specifikus korlátozás' };
  }

  const targetId = extractUrlId(courseIdentifier);
  const targetStr = String(courseIdentifier).toLowerCase();

  let matchedRule = null;
  let matchedKey = null;

  for (const [key, rule] of Object.entries(courseSchedules)) {
    const keyId = extractUrlId(key);
    if (
      (targetId && keyId && targetId === keyId) ||
      targetStr.includes(key.toLowerCase()) ||
      key.toLowerCase().includes(targetStr)
    ) {
      matchedRule = rule;
      matchedKey = key;
      break;
    }
  }

  if (!matchedRule) {
    return { allowed: true, reason: 'Erre a tárgyra nincs külön csoport-idősáv megadva' };
  }

  const windows = Array.isArray(matchedRule) ? matchedRule : matchedRule.windows;
  const courseName = matchedRule.name || matchedKey;
  const bufferBefore =
    typeof matchedRule.buffer_before_minutes === 'number'
      ? matchedRule.buffer_before_minutes
      : 10; // Default -10 min pre-class buffer

  if (!Array.isArray(windows) || windows.length === 0) {
    return { allowed: true, courseName, reason: `${courseName}: üres idősáv lista (mindig engedélyezve)` };
  }

  const { weekdayRaw, currentTime, currentMinutes } = getCurrentTimeParts(config, now);

  for (const win of windows) {
    if (!win.day || !win.start || !win.end) continue;
    const normDay = DAY_MAP[String(win.day).toLowerCase().trim()] || win.day;
    if (normDay.toLowerCase() !== weekdayRaw.toLowerCase()) continue;

    const startMin = parseTimeToMinutes(win.start) - bufferBefore;
    const endMin = parseTimeToMinutes(win.end);

    if (currentMinutes >= startMin && currentMinutes <= endMin) {
      return {
        allowed: true,
        courseName,
        reason: `${courseName}: Saját csoport idősávban (${normDay} ${win.start}-${win.end}, -${bufferBefore}p bufferrel, most: ${currentTime})`,
      };
    }
  }

  const winSummary = windows.map((w) => `${w.day} ${w.start}-${w.end}`).join(', ');
  return {
    allowed: false,
    courseName,
    reason: `"${courseName}" most nem a te csoportod órája! (Most: ${weekdayRaw} ${currentTime} | Saját sávod: ${winSummary}, -${bufferBefore}p bufferrel)`,
  };
}
