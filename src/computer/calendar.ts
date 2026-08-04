import type { ToolContext } from '../agent/types.js';
import type { JarvGenieConfig } from '../config/index.js';
import { controlAllowed, runAppleScript } from './index.js';

/**
 * macOS Calendar integration (read the day's agenda, create events). Uses
 * AppleScript against the Calendar app, so it requires computer.allowControl
 * and Automation (Apple Events → Calendar) permission.
 */

export interface CalendarEvent {
  start: string;
  summary: string;
  location: string;
}

function escapeLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Build AppleScript date-literal lines that set a Date from ISO components. */
function dateLines(varName: string, d: Date, indent: string): string[] {
  return [
    `${indent}set ${varName} to current date`,
    `${indent}set year of ${varName} to ${d.getFullYear()}`,
    `${indent}set month of ${varName} to ${d.getMonth() + 1}`,
    `${indent}set day of ${varName} to ${d.getDate()}`,
    `${indent}set hours of ${varName} to ${d.getHours()}`,
    `${indent}set minutes of ${varName} to ${d.getMinutes()}`,
    `${indent}set seconds of ${varName} to 0`,
  ];
}

function requireControl(ctx: ToolContext): { ok: boolean; error?: string } {
  const config = ctx.config as JarvGenieConfig;
  if (!controlAllowed(config)) {
    return {
      ok: false,
      error:
        'approval required: set computer.allowControl=true in ~/.jarv-genie/config.json (restart the hub afterwards) to enable calendar tools',
    };
  }
  return { ok: true };
}

/**
 * List calendar events whose start falls in [start, end). Returns ISO-ish
 * start timestamps with summary and location, sorted by start time.
 */
export async function calendarAgenda(start: Date, end: Date): Promise<CalendarEvent[]> {
  const lines = [
    ...dateLines('theStart', start, '  '),
    '  set theEnd to theStart + ((theEndMinutes) * minutes)',
    '  set out to ""',
    '  tell application "Calendar"',
    '    repeat with c in every calendar',
    '      set evs to (every event of c whose start date is greater than or equal to theStart and start date is less than theEnd)',
    '      repeat with e in evs',
    '        try',
    '          set s to start date of e',
    `          set out to out & ((year of s) as text) & "-" & ((month of s) as integer) & "-" & ((day of s) as text) & "T" & ((hours of s) as text) & ":" & ((minutes of s) as text) & "|" & (summary of e) & "|" & (location of e) & linefeed`,
    '        end try',
    '      end repeat',
    '    end repeat',
    '  end tell',
    '  return out',
  ].join('\n');

  // Inject the end window as a duration in minutes so AppleScript arithmetic
  // stays timezone/locale independent.
  const script = `set theEndMinutes to ${Math.round((end.getTime() - start.getTime()) / 60000)}\n${lines}`;
  const out = await runAppleScript(script);
  return out
    .split('\n')
    .map((l) => {
      const [startIso, summary, location] = l.split('|');
      if (!startIso || !summary) return null;
      return { start: startIso, summary: summary.trim(), location: (location ?? '').trim() };
    })
    .filter((e): e is CalendarEvent => e !== null)
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** Create a calendar event. `end` defaults to start + 1 hour. */
export async function calendarAdd(opts: {
  title: string;
  start: Date;
  end?: Date;
  location?: string;
  calendar?: string;
}): Promise<string> {
  const start = opts.start;
  const end = opts.end ?? new Date(start.getTime() + 60 * 60 * 1000);
  const calSelector = opts.calendar
    ? `first calendar whose name is "${escapeLiteral(opts.calendar)}"`
    : 'first calendar whose writable is true';
  const lines = [
    ...dateLines('d1', start, '  '),
    ...dateLines('d2', end, '  '),
    '  tell application "Calendar"',
    `    set theCal to ${calSelector}`,
    `    make new event at end of theCal with properties {summary:"${escapeLiteral(opts.title)}", start date:d1, end date:d2${opts.location ? `, location:"${escapeLiteral(opts.location)}"` : ''}}`,
    '    return name of theCal',
    '  end tell',
  ].join('\n');
  return (await runAppleScript(lines)).trim();
}

/** macOS Calendar has no CLI; control-gating is enforced by the tool handlers. */
export { requireControl };
