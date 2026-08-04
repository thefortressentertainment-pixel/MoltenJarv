import type { ToolContext, ToolDefinition } from '../agent/types.js';
import { calendarAdd, calendarAgenda, requireControl } from '../computer/calendar.js';

export function calendarTools(): ToolDefinition[] {
  return [
    {
      name: 'calendar_agenda',
      description:
        "List calendar events in the macOS Calendar app for the next N days (default 1 = today). Returns start time, summary, and location for each event. Read-only. Use to know the user's schedule. Requires computer.allowControl=true.",
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Number of days ahead to show, starting today (default 1).' },
          windowStart: { type: 'string', description: 'Optional ISO date to start from, e.g. "2026-08-05". Default: now.' },
        },
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const gate = requireControl(ctx);
        if (!gate.ok) return gate;
        const start = args.windowStart ? new Date(String(args.windowStart)) : new Date();
        const days = Math.min(Math.max(Math.trunc(Number(args.days ?? 1) || 1), 1), 30);
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + days);
        const events = await calendarAgenda(start, end);
        if (events.length === 0) {
          return { ok: true, count: 0, events: [], note: `no events between now and ${end.toISOString().slice(0, 10)}` };
        }
        return { ok: true, count: events.length, events };
      },
    },
    {
      name: 'calendar_add',
      description:
        'Create an event in the macOS Calendar app. Provide a title, start (ISO 8601, e.g. "2026-08-05T14:00:00"), optional end, optional location, and optional calendar name. Requires computer.allowControl=true.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title.' },
          start: { type: 'string', description: 'ISO 8601 start datetime.' },
          end: { type: 'string', description: 'Optional ISO 8601 end datetime (default: start + 1 hour).' },
          location: { type: 'string', description: 'Optional location.' },
          calendar: { type: 'string', description: 'Optional calendar name (default: first writable calendar).' },
        },
        required: ['title', 'start'],
      },
      consequential: true,
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const gate = requireControl(ctx);
        if (!gate.ok) return gate;
        const title = String(args.title ?? '').trim();
        if (!title) return { ok: false, error: 'title is required' };
        const start = new Date(String(args.start ?? ''));
        if (Number.isNaN(start.getTime())) return { ok: false, error: `invalid start date: ${String(args.start)}` };
        const end = args.end ? new Date(String(args.end)) : undefined;
        if (end && Number.isNaN(end.getTime())) return { ok: false, error: `invalid end date: ${String(args.end)}` };
        try {
          const calendar = await calendarAdd({
            title,
            start,
            end,
            location: args.location ? String(args.location) : undefined,
            calendar: args.calendar ? String(args.calendar) : undefined,
          });
          return { ok: true, created: title, calendar };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
