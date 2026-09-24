/**
 * Automation schedules.
 *
 * A schedule is data, not prose, so the server can decide when a workflow is
 * due without guessing at English:
 *
 *   { type: 'interval', everyMinutes: 60 }
 *   { type: 'daily',    time: '09:00', daysOfWeek: [1] }   // 1 = Monday (ISO)
 *   { type: 'monthly',  day: 1, time: '09:00' }
 *   { type: 'event',    event: 'project.status', value: 'In review' }
 *   { type: 'manual' }
 *
 * Times are wall-clock times in the workspace's time zone, because "every
 * Monday at 9" means 9am for the person who wrote it, not 9am UTC. Conversions
 * use Intl rather than a date library: no dependency, and DST transitions are
 * handled by asking the platform for the real offset instead of assuming one.
 */

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Local wall-clock fields for an instant, in a given IANA time zone. */
export function zonedParts(timestampMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(timestampMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  // Some ICU builds report midnight as hour 24.
  parts.hour = (parts.hour || 0) % 24;
  return parts;
}

/** Offset of a time zone at an instant, in milliseconds east of UTC. */
export function zoneOffsetMs(timestampMs, timeZone) {
  const parts = zonedParts(timestampMs, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(timestampMs / 1000) * 1000;
}

/** Converts a wall-clock time in a time zone into the matching UTC instant. */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = naive - zoneOffsetMs(naive, timeZone);
  // Re-check once: near a DST boundary the first offset may already be stale.
  const refined = naive - zoneOffsetMs(candidate, timeZone);
  if (refined !== candidate) candidate = refined;
  return candidate;
}

const pad = (value) => String(value).padStart(2, '0');

/**
 * The next instant this schedule should fire, or null for schedules that are
 * only triggered by events or by hand. Never returns a moment in the past, so a
 * server that was offline for a week runs a workflow once rather than 168 times.
 */
export function nextOccurrence(schedule, fromMs, timeZone = 'UTC') {
  if (!schedule) return null;
  const from = Number.isFinite(fromMs) ? fromMs : Date.now();

  if (schedule.type === 'interval') {
    // Sub-minute intervals are allowed on purpose: they make the scheduler
    // observable in tests and are genuinely useful for quick polling jobs.
    const every = Math.max(0.1, Number(schedule.everyMinutes) || 60);
    return from + every * 60_000;
  }

  if (schedule.type === 'daily') {
    const [hour, minute] = String(schedule.time || '09:00').split(':').map(Number);
    const days = Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length
      ? schedule.daysOfWeek.map(Number)
      : [0, 1, 2, 3, 4, 5, 6];
    const local = zonedParts(from, timeZone);
    for (let step = 0; step <= 8; step += 1) {
      // Walk forward one calendar day at a time in local terms.
      const cursor = new Date(Date.UTC(local.year, local.month - 1, local.day + step));
      const weekday = cursor.getUTCDay();
      if (!days.includes(weekday)) continue;
      const candidate = zonedTimeToUtc({
        year: cursor.getUTCFullYear(),
        month: cursor.getUTCMonth() + 1,
        day: cursor.getUTCDate(),
        hour: Number.isFinite(hour) ? hour : 9,
        minute: Number.isFinite(minute) ? minute : 0,
      }, timeZone);
      if (candidate > from) return candidate;
    }
    return null;
  }

  if (schedule.type === 'monthly') {
    const [hour, minute] = String(schedule.time || '09:00').split(':').map(Number);
    const local = zonedParts(from, timeZone);
    for (let step = 0; step <= 2; step += 1) {
      const cursor = new Date(Date.UTC(local.year, local.month - 1 + step, 1));
      const year = cursor.getUTCFullYear();
      const month = cursor.getUTCMonth() + 1;
      const day = Math.min(Math.max(1, schedule.day || 1), new Date(Date.UTC(year, month, 0)).getUTCDate());
      const candidate = zonedTimeToUtc({ year, month, day, hour: hour || 9, minute: minute || 0 }, timeZone);
      if (candidate > from) return candidate;
    }
    return null;
  }

  return null; // event and manual schedules have no clock of their own
}

const formatClock = (time = '09:00') => {
  const [hour, minute] = String(time).split(':').map(Number);
  const suffix = (Number.isFinite(hour) ? hour : 9) >= 12 ? 'PM' : 'AM';
  const display = (Number.isFinite(hour) ? hour : 9) % 12 || 12;
  return `${display}:${pad(Number.isFinite(minute) ? minute : 0)} ${suffix}`;
};

const ordinal = (day) => {
  if (day % 10 === 1 && day !== 11) return `${day}st`;
  if (day % 10 === 2 && day !== 12) return `${day}nd`;
  if (day % 10 === 3 && day !== 13) return `${day}rd`;
  return `${day}th`;
};

/** The label the UI shows for a schedule. */
export function describeSchedule(schedule) {
  if (!schedule) return 'Manual only';
  switch (schedule.type) {
    case 'interval': {
      const raw = Math.max(0.1, Number(schedule.everyMinutes) || 60);
      if (raw < 1) return `Every ${Math.round(raw * 60)} seconds`;
      const minutes = Math.round(raw);
      if (minutes < 60) return `Every ${minutes} minute${minutes === 1 ? '' : 's'}`;
      if (minutes % 1440 === 0) return `Every ${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
      if (minutes % 60 === 0) return `Every ${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
      return `Every ${minutes} minutes`;
    }
    case 'daily': {
      const days = Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length ? schedule.daysOfWeek.map(Number) : null;
      const sorted = days ? [...days].sort((a, b) => a - b) : null;
      const isWeekdays = sorted && sorted.length === 5 && sorted.every((day) => day >= 1 && day <= 5);
      const isEveryDay = !sorted || sorted.length === 7;
      const dayLabel = isEveryDay
        ? 'Every day'
        : isWeekdays
          ? 'Every weekday'
          : sorted.length === 1
            ? `Every ${WEEKDAYS[sorted[0]]}`
            : `Every ${sorted.map((day) => WEEKDAYS[day].slice(0, 3)).join(', ')}`;
      return `${dayLabel} · ${formatClock(schedule.time)}`;
    }
    case 'monthly':
      return `On the ${ordinal(schedule.day || 1)} of each month · ${formatClock(schedule.time)}`;
    case 'event':
      return `When ${describeEvent(schedule)}`;
    case 'manual':
      return 'Manual only';
    default:
      return 'Manual only';
  }
}

function describeEvent(schedule) {
  if (schedule.event === 'project.status') return `a project is marked “${schedule.value}”`;
  if (schedule.event === 'project.created') return 'a project is created';
  return 'an event fires';
}

/** "12 minutes", "3 hours", "in 2 days" — used next to a due timestamp. */
export function humanizeUntil(targetMs, fromMs = Date.now()) {
  const delta = targetMs - fromMs;
  if (!Number.isFinite(delta)) return 'soon';
  if (delta <= 0) return 'due now';
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return 'in under a minute';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Best-effort conversion of the prose triggers that shipped in the first
 * prototype, so old rows keep working after the upgrade.
 */
export function parseTriggerLabel(label) {
  const value = String(label || '').trim();
  if (!value) return { schedule: { type: 'manual' } };

  const statusMatch = value.match(/when (?:a )?project is (?:marked|set to|changed to) "?([^"]+)"?/i);
  if (statusMatch) return { schedule: { type: 'event', event: 'project.status', value: statusMatch[1].trim() } };
  if (/when status changes to (.+)/i.test(value)) {
    return { schedule: { type: 'event', event: 'project.status', value: value.match(/when status changes to (.+)/i)[1].trim() } };
  }
  if (/on demand|manual|when you run/i.test(value)) return { schedule: { type: 'manual' } };

  const firstOfMonth = value.match(/first day of each month/i);
  const clock = value.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  const time = clock ? toTwentyFour(clock[1], clock[2], clock[3]) : '09:00';
  if (firstOfMonth) return { schedule: { type: 'monthly', day: 1, time } };

  const dayMatch = value.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
  if (dayMatch) {
    const day = WEEKDAYS.findIndex((name) => name.toLowerCase() === dayMatch[1].toLowerCase());
    if (day >= 0) return { schedule: { type: 'daily', time, daysOfWeek: [day] } };
  }

  const intervalMatch = value.match(/every (\d+)\s*(minute|hour|day)/i);
  if (intervalMatch) {
    const amount = Number(intervalMatch[1]);
    const unit = intervalMatch[2].toLowerCase();
    const everyMinutes = unit === 'day' ? amount * 1440 : unit === 'hour' ? amount * 60 : amount;
    return { schedule: { type: 'interval', everyMinutes } };
  }
  if (/every day|daily/i.test(value)) return { schedule: { type: 'daily', time, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] } };

  return { schedule: { type: 'manual' } };
}

function toTwentyFour(hourValue, minuteValue, meridiem) {
  let hour = Number(hourValue) % 12;
  if (String(meridiem).toUpperCase() === 'PM') hour += 12;
  return `${pad(hour)}:${pad(Number(minuteValue) || 0)}`;
}

/** Validates a schedule coming from the API. Returns { schedule } or { error }. */
export function normalizeSchedule(input) {
  if (!input || typeof input !== 'object') return { schedule: { type: 'manual' } };
  const type = String(input.type || 'manual');
  if (type === 'interval') {
    const requested = Number(input.everyMinutes);
    // 0.1 minutes (6 seconds) is the floor: below that a schedule is really a
    // polling loop, and the floor keeps the tests honest and fast.
    if (!Number.isFinite(requested) || requested < 0.1) return { error: 'An interval needs to be at least 6 seconds.' };
    if (requested > 43_200) return { error: 'Intervals longer than 30 days are not supported.' };
    const everyMinutes = Math.round(requested * 100) / 100;
    return { schedule: { type, everyMinutes } };
  }
  if (type === 'daily') {
    const days = Array.isArray(input.daysOfWeek) && input.daysOfWeek.length ? [...new Set(input.daysOfWeek.map(Number).filter((day) => day >= 0 && day <= 6))] : [0, 1, 2, 3, 4, 5, 6];
    if (!days.length) return { error: 'Choose at least one day of the week.' };
    return { schedule: { type, time: normalizeTime(input.time), daysOfWeek: days.sort((a, b) => a - b) } };
  }
  if (type === 'monthly') {
    const day = Math.round(Number(input.day));
    if (!Number.isFinite(day) || day < 1 || day > 28) return { error: 'Pick a day between 1 and 28 so every month has it.' };
    return { schedule: { type, day, time: normalizeTime(input.time) } };
  }
  if (type === 'event') {
    const value = String(input.value || '').trim().slice(0, 60);
    if (!value) return { error: 'An event trigger needs a value to watch for.' };
    return { schedule: { type, event: String(input.event || 'project.status'), value } };
  }
  return { schedule: { type: 'manual' } };
}

const normalizeTime = (value) => {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '09:00';
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${pad(hour)}:${pad(minute)}`;
};
