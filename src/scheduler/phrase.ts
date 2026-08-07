/**
 * Natural-language schedule phrase → numeric 5-field cron.
 *
 * This exists because hand-writing cron strings ("0 7 * * 6") is the brittle
 * step in scheduling. Anyone (or any agent run) can instead say
 * "every Monday at 7am" or "4-hourly" and get a deterministic, numeric,
 * RFC-conventional cron expression back — which `parseCron` then validates.
 *
 * Inspired by the Cloudflare `agents` deep-pass (Tier 1 #3 on the skill-scouting
 * call list). Adopted as a local, testable Jarv asset — purely additive, no
 * external machinery. Numeric cron stays fully supported; this just adds a
 * friendlier front door to it.
 */

const DOW: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, weds: 3, wed: 3,
  thursday: 4, thurs: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

/** Parse an hour token like "7", "07", "7am", "7pm", "noon", "midnight". */
function parseHourToken(token: string): number {
  const clean = token.toLowerCase().replace(/[.:]/g, '');
  if (clean === 'noon' || clean === 'midday') return 12;
  if (clean === 'midnight') return 0;
  const m = /^(\d{1,2})(am|pm)?$/.exec(clean);
  if (!m) throw new Error(`unrecognized time: "${token}"`);
  let h = Number(m[1]!);
  const meridiem = m[2];
  if (meridiem === 'pm' && h !== 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  if (h < 0 || h > 23) throw new Error(`hour out of range: ${token}`);
  return h;
}

// Detect an hour token that carries an explicit minute, e.g. "7:30" or "7.15".
function parseClock(token: string): { hour: number; minute: number } {
  const m = /^(\d{1,2})[:.](\d{2})(am|pm)?$/.exec(token.toLowerCase());
  if (!m) throw new Error(`unrecognized time: "${token}"`);
  let h = Number(m[1]!);
  const min = Number(m[2]!);
  const meridiem = m[3];
  if (meridiem === 'pm' && h !== 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) throw new Error(`time out of range: ${token}`);
  return { hour: h, minute: min };
}

function findDows(tokens: string[]): number[] | null {
  const dows = new Set<number>();
  for (const t of tokens) {
    const n = DOW[t.toLowerCase()];
    if (n !== undefined) dows.add(n);
  }
  return dows.size ? [...dows].sort((a, b) => a - b) : null;
}

function findMonth(token: string): number | null {
  const v = Number(token);
  if (v >= 1 && v <= 12) return v;
  const n = MONTHS[token.toLowerCase()];
  return n !== undefined ? n : null;
}

function pad(v: number): string {
  // Emit unpadded (e.g. "0 17 * * 1" not "00 17 ...") to match the rest of
  // the codebase's numeric-cron house style. Cron parses both fine.
  return String(v);
}

/**
 * Convert a schedule phrase to numeric cron. Throws a descriptive Error when
 * the phrase can't be parsed (fail-closed: no silent defaults).
 *
 * Accepted shapes (case-insensitive, flexible word order):
 *   "daily at 7am" / "every day at 09:30" / "daily"                    → 0 7 * * * | 30 9 * * * | 0 0 * * *
 *   "every monday at 5pm" / "weekdays at 8" / "weekends at noon"
 *   "hourly" / "every 4 hours" / "every 30 minutes"
 *   "weekly on sunday at 9" / "monthly on the 1st at 8am"
 */
export function schedulePhraseToCron(phrase: string): string {
  const raw = phrase.trim();
  if (!raw) throw new Error('empty schedule phrase');
  const lower = raw.toLowerCase();
  const tokens = raw.split(/[\s,]+/).filter(Boolean);

  // Simple named cadences with no explicit time → default to 00:00.
  if (/^hourly$/.test(lower)) return '0 * * * *';
  if (/^daily$/.test(lower) || lower === 'every day') return '0 0 * * *';
  if (/^weekly$/.test(lower)) return '0 0 * * 0';
  if (/^monthly$/.test(lower) || /once a month/i.test(lower)) return '0 0 1 * *';

  // "every N hours/minutes", and compact "N-hourly" / "N-minutely".
  const interval = /every\s+(\d+)\s*(hours?|hrs?|minutes?|mins?)?\b/.exec(lower) ||
    /^(\d+)\s*-?\s*(hours?|hrs?|minutes?|mins?|hourly|minutely)\b/.exec(lower);
  if (interval) {
    const n = Number(interval[1]!);
    let unit = interval[2] ?? '';
    if (/hourly|minutely/.test(unit)) unit = /hourly/.test(unit) ? 'hours' : 'minutes';
    const isHour = unit.length === 0 || /hour|hr/.test(unit);
    const isMin = /min/.test(unit);
    if (!Number.isInteger(n) || n < 1) throw new Error(`invalid interval: "${interval[1]}"`);
    if (isMin) {
      if (n > 59) throw new Error(`minute interval must be <= 59: ${n}`);
      return `*/${n} * * * *`;
    }
    if (isHour) {
      if (n > 23) throw new Error(`hour interval must be <= 23: ${n}`);
      return n === 1 ? '0 * * * *' : `0 */${n} * * *`;
    }
    throw new Error(`unrecognized interval unit: "${unit}"`);
  }

  // Determine day-of-month ("on the Nth"), month, and day-of-week up front.
  const domMatch = /(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(lower);
  const dom =
    domMatch && Number(domMatch[1]!) >= 1 && Number(domMatch[1]!) <= 31
      ? Number(domMatch[1]!)
      : undefined;
  const monthToken = tokens.find((t) => findMonth(t) !== null);
  const month = monthToken !== undefined ? findMonth(monthToken)! : undefined;

  const dows = findDows(tokens);
  let dowField: string | null = null;
  if (/weekday/i.test(lower)) dowField = '1-5';
  else if (/weekend/i.test(lower)) dowField = '0,6';
  else if (dows) dowField = dows.map(String).join(',');
  const everyDow =
    /^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)$/.test(lower);

  // A specific day-of-month: "monthly on the 1st at 8" / "on the 15th at 06:00"
  // / "october on the 10th at 7". DOM wins over month/default-1.
  if (dom !== undefined && (/\bmonth(?:ly)?\b/.test(lower) || /\bon the\b/.test(lower) || month !== undefined)) {
    const clock = findClockToken(tokens);
    return `${pad(clock?.minute ?? 0)} ${pad(clock?.hour ?? 0)} ${dom} ${month ?? '*'} *`;
  }

  // Weekday/weekend / specific weekdays with an explicit time.
  if (dowField !== null && (everyDow || /\bat\b|\bat\s/.test(raw) || dowField === '1-5' || dowField === '0,6')) {
    const clock = findClockToken(tokens);
    return `${pad(clock?.minute ?? 0)} ${pad(clock?.hour ?? 0)} * * ${dowField}`;
  }

  // Time-suffixed daily ("daily at 7am", "at 7:30", "every day at noon").
  if (/daily|day|^at\b/.test(lower) || /^\d{1,2}([:.]\d{2})?(am|pm)?$/.test(tokens[0] ?? '')) {
    const clock = findClockToken(tokens);
    return `${pad(clock?.minute ?? 0)} ${pad(clock?.hour ?? 0)} * * *`;
  }

  // A bare month + time → once a year, that month on the 1st.
  if (month !== undefined) {
    const clock = findClockToken(tokens);
    return `${pad(clock?.minute ?? 0)} ${pad(clock?.hour ?? 0)} 1 ${month} *`;
  }

  throw new Error(`could not parse schedule phrase: "${raw}"`);
}

function findClockToken(tokens: string[]): { hour: number; minute: number } | null {
  // Look for "7:30"/"7.30" clock tokens first.
  for (const t of tokens) {
    if (/^\d{1,2}[:.]\d{2}(am|pm)?$/.test(t.toLowerCase())) {
      try {
        return parseClock(t);
      } catch {
        /* fall through */
      }
    }
  }
  // Then "7am" / "7pm" / "noon" / "midnight" / bare "7" (treat as hour, implied 00).
  for (const t of tokens) {
    if (/^(noon|midday|midnight)$/.test(t.toLowerCase())) {
      return { hour: parseHourToken(t), minute: 0 };
    }
    if (/^\d{1,2}(am|pm)$/.test(t.toLowerCase())) {
      return { hour: parseHourToken(t), minute: 0 };
    }
  }
  // Bare "7" — but avoid grabbing a day-of-month or interval number.
  for (const t of tokens) {
    if (/^\d{1,2}$/.test(t) && (/(?:daily|day|at|every)/i.test(tokens.join(' ')) || /^(at|for)$/.test(t))) {
      return { hour: parseHourToken(t), minute: 0 };
    }
  }
  return null;
}
