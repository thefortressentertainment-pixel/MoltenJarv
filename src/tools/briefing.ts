import type { ToolContext, ToolDefinition } from '../agent/types.js';
import type { JarvGenieConfig } from '../config/index.js';
import { controlAllowed, runAppleScript } from '../computer/index.js';
import { systemStatus, statusSummary } from '../computer/status.js';
import { calendarAgenda } from '../computer/calendar.js';

/**
 * Daily briefing: one call that assembles the state of the user's world the
 * way a butler would at the start of the day — time, today's calendar, open
 * reminders, and the health of the machine. Every section degrades gracefully
 * if a permission or service is unavailable.
 */

interface BriefingSection {
  name: string;
  body: string;
  error?: string;
}

async function remindersBriefing(ctx: ToolContext): Promise<BriefingSection> {
  if (!controlAllowed(ctx.config as JarvGenieConfig)) {
    return { name: 'reminders', body: '', error: 'computer.allowControl is off' };
  }
  try {
    const out = await runAppleScript(
      'tell application "Reminders"\n  tell list "Reminders"\n    get name of every reminder whose completed is false\n  end tell\nend tell',
    );
    const items = out
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { name: 'reminders', body: items.length ? `- ${items.join('\n- ')}` : '(none open)' };
  } catch (err) {
    return { name: 'reminders', body: '', error: err instanceof Error ? err.message : String(err) };
  }
}

export function briefingTools(): ToolDefinition[] {
  return [
    {
      name: 'daily_briefing',
      description:
        "Assemble the user's morning briefing: current time, today's calendar agenda, open reminders, and machine status (battery, disk, network). Use when the user asks for a briefing, a summary of their day, or 'what's going on'. Every section degrades gracefully if a permission is missing.",
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Days of calendar agenda to include (default 1 = today).' },
        },
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const now = new Date();
        const days = Math.min(Math.max(Math.trunc(Number(args.days ?? 1) || 1), 1), 7);
        const sections: BriefingSection[] = [];

        const time = now.toLocaleString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        sections.push({ name: 'time', body: time });

        try {
          const events = await calendarAgenda(now, new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
          sections.push({
            name: 'agenda',
            body: events.length
              ? events.map((e) => `- ${e.start} ${e.summary}${e.location ? ` @ ${e.location}` : ''}`).join('\n')
              : `(nothing scheduled in the next ${days} day${days === 1 ? '' : 's'})`,
          });
        } catch (err) {
          sections.push({ name: 'agenda', body: '', error: err instanceof Error ? err.message : String(err) });
        }

        sections.push(await remindersBriefing(ctx));

        try {
          const status = await systemStatus();
          sections.push({ name: 'machine', body: statusSummary(status) });
        } catch (err) {
          sections.push({ name: 'machine', body: '', error: err instanceof Error ? err.message : String(err) });
        }

        const failures = sections.filter((s) => s.error);
        return {
          ok: true,
          date: now.toISOString(),
          briefing: sections.map((s) => `## ${s.name}\n${s.body || `(unavailable: ${s.error})`}`).join('\n\n'),
          unavailable: failures.map((s) => `${s.name}: ${s.error}`),
        };
      },
    },
  ];
}
