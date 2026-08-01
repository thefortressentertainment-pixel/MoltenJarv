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
    month: parseField(mon, 1, 12),
    dayOfWeek: parseField(dow, 0, 7),
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

function parseField(field: string, min: number, max: number): number[] {
  if (field === '*') return range(min, max);
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (!part) throw new Error(`invalid cron field: ${field}`);
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    if (stepMatch) {
      const basePart = stepMatch[1]!;
      const step = Number(stepMatch[2]!);
      const base: [number, number] = basePart === '*' ? [min, max] : parseRange(basePart, min, max);
      for (let v = base[0]; v <= base[1]; v += step) values.add(v);
      continue;
    }
    const [a, b] = parseRange(part, min, max);
    for (let v = a; v <= b; v++) values.add(v);
  }
  const out = [...values].filter((v) => v >= min && v <= max).sort((x, y) => x - y);
  if (out.length === 0) throw new Error(`cron field out of range: ${field}`);
  return out;
}

function parseRange(part: string, min: number, max: number): [number, number] {
  const dash = part.split('-');
  if (dash.length === 1) {
    const v = Number(dash[0]!);
    if (!Number.isInteger(v)) throw new Error(`invalid cron value: ${part}`);
    return [v, v];
  }
  const a = Number(dash[0]!);
  const b = Number(dash[1]!);
  if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`invalid cron range: ${part}`);
  if (a > b) throw new Error(`cron range reversed: ${part}`);
  return [a, b];
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
