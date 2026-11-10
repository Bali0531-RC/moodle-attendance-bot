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

/**
 * Checks if the current time (or a given Date) falls inside any of the configured
 * daily time windows in `config.active_schedule`.
 *
 * Returns:
 *   { active: boolean, dayName: string, currentTime: string, reason: string }
 */
export function checkActiveSchedule(config, now = new Date()) {
  const timeZone = config.timezone || 'Europe/Budapest';
  const schedule = config.active_schedule;

  // If no active_schedule is configured, always active
  if (!schedule || Object.keys(schedule).length === 0) {
    return { active: true, dayName: 'All', currentTime: '', reason: 'Nincs időkorlát beállítva' };
  }

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

  // Normalize keys in config.active_schedule so both "Monday" and "Hétfő" work
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
