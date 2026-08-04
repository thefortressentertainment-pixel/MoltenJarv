/**
 * Minimal 5-field cron parser: minute hour day-of-month month day-of-week.
 * Supports star, step values, ranges, comma lists, and @hourly/@daily aliases.
 */
export interface CronExpression {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@midnight': '0 0 * * *',
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, su: 0,
  mon: 1, monday: 1, mo: 1,
  tue: 2, tues: 2, tuesday: 2, tu: 2,
  wed: 3, weds: 3, wednesday: 3, we: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, th: 4,
  fri: 5, friday: 5, fr: 5,
  sat: 6, saturday: 6, sa: 6,
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function resolveName(token: string, names: Record<string, number> | undefined): string {
  if (!names) return token;
  const n = names[token.toLowerCase()];
  return n === undefined ? token : String(n);
}

export function parseCron(expr: string): CronExpression {
  const raw = (ALIASES[expr] ?? expr).trim();
  const parts = raw.split(/\s+/);
  const [min, hour, dom, mon, dow] = parts;
  if (parts.length !== 5 || min === undefined || hour === undefined || dom === undefined || mon === undefined || dow === undefined) {
    throw new Error(`invalid cron expression: ${expr}`);
  }
  return {
    minute: parseField(min, 0, 59),
    hour: parseField(hour, 0, 23),
    dayOfMonth: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12, MONTH_NAMES),
    dayOfWeek: parseField(dow, 0, 7, DOW_NAMES),
  };
}

export function cronMatches(expr: CronExpression, date: Date): boolean {
  const dow = date.getDay();
  return (
    expr.minute.includes(date.getMinutes()) &&
    expr.hour.includes(date.getHours()) &&
    expr.dayOfMonth.includes(date.getDate()) &&
    expr.month.includes(date.getMonth() + 1) &&
    (expr.dayOfWeek.includes(dow) || expr.dayOfWeek.includes(7)) // 7 == sunday
  );
}

/** The most recent moment before `before` that the expression matches. */
export function previousFire(expr: CronExpression, before: Date): Date {
  const d = new Date(before.getTime() - 60_000);
  for (let i = 0; i < 60 * 24 * 40; i++) {
    if (cronMatches(expr, d)) return d;
    d.setTime(d.getTime() - 60_000);
  }
  return before;
}

function parseField(field: string, min: number, max: number, names?: Record<string, number>): number[] {
  if (field === '*') return range(min, max);
  const values = new Set<number>();
  for (const partRaw of field.split(',')) {
    const part = resolveName(partRaw, names);
    if (!part) throw new Error(`invalid cron field: ${field}`);
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    if (stepMatch) {
      const basePart = resolveName(stepMatch[1]!, names);
      const step = Number(stepMatch[2]!);
      const base: [number, number] = basePart === '*' ? [min, max] : parseRange(basePart, min, max, names);
      for (let v = base[0]; v <= base[1]; v += step) values.add(v);
      continue;
    }
    const [a, b] = parseRange(part, min, max, names);
    for (let v = a; v <= b; v++) values.add(v);
  }
  const out = [...values].filter((v) => v >= min && v <= max).sort((x, y) => x - y);
  if (out.length === 0) throw new Error(`cron field out of range: ${field}`);
  return out;
}

function parseRange(part: string, min: number, max: number, names?: Record<string, number>): [number, number] {
  const dash = part.split('-');
  if (dash.length === 1) {
    const v = Number(resolveName(dash[0]!, names));
    if (!Number.isInteger(v)) throw new Error(`invalid cron value: ${part}`);
    return [v, v];
  }
  const a = Number(resolveName(dash[0]!, names));
  const b = Number(resolveName(dash[1]!, names));
  if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`invalid cron range: ${part}`);
  if (a > b) throw new Error(`cron range reversed: ${part}`);
  return [a, b];
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
