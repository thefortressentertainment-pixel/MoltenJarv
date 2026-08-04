import type { ToolDefinition, ToolContext } from '../agent/types.js';
import type { JarvGenieConfig } from '../config/index.js';
import { controlAllowed, runAppleScript } from '../computer/index.js';

/**
 * macOS Reminders integration (one-time reminders). The tool builds correct,
 * locale-independent AppleScript from structured arguments so the model never
 * has to write AppleScript itself. Requires computer.allowControl=true.
 *
 * Note: the Reminders AppleScript dictionary does not expose recurrence, so
 * recurring alarms should be created with the scheduler tools instead
 * (schedule_add with a cron expression).
 */

function escapeLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function requireControl(ctx: ToolContext): { ok: boolean; error?: string } {
  const config = ctx.config as JarvGenieConfig;
  if (!controlAllowed(config)) {
    return {
      ok: false,
      error:
        'approval required: set computer.allowControl=true in ~/.jarv-genie/config.json (restart the hub afterwards) to enable reminders and control actions',
    };
  }
  return { ok: true };
}

function listArg(list: string | undefined): string {
  return list && list.trim() ? escapeLiteral(list.trim()) : 'Reminders';
}

/**
 * Build AppleScript that sets a date object from an ISO string by assigning
 * components (locale-independent — avoids date-string coercion).
 */
function setDateLines(iso: string | undefined, indent: string): string[] {
  if (!iso) return [];
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return [];
  return [
    `${indent}set d to current date`,
    `${indent}set year of d to ${t.getFullYear()}`,
    `${indent}set month of d to ${t.getMonth() + 1}`,
    `${indent}set day of d to ${t.getDate()}`,
    `${indent}set hours of d to ${t.getHours()}`,
    `${indent}set minutes of d to ${t.getMinutes()}`,
    `${indent}set seconds of d to 0`,
    `${indent}set due date of newReminder to d`,
  ];
}

export function reminderTools(): ToolDefinition[] {
  return [
    {
      name: 'reminder_create',
      description:
        'Create a one-time reminder in the macOS Reminders app with an optional due date (ISO 8601, e.g. "2026-08-08T07:00:00"). For RECURRING alarms/reminders use schedule_add with a cron expression instead. Requires computer.allowControl=true.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The reminder text/name.' },
          list: { type: 'string', description: 'Reminders list (default "Reminders").' },
          dueDate: { type: 'string', description: 'ISO 8601 due date, e.g. 2026-08-08T07:00:00.' },
        },
        required: ['name'],
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const gate = requireControl(ctx);
        if (!gate.ok) return gate;
        const name = String(args.name ?? '').trim();
        if (!name) return { ok: false, error: 'name is required' };
        const list = listArg(args.list as string | undefined);
        try {
          const lines = [
            'tell application "Reminders"',
            `  tell list "${list}"`,
            `    set newReminder to make new reminder at end with properties {name:"${escapeLiteral(name)}"}`,
          ];
          lines.push(...setDateLines(args.dueDate ? String(args.dueDate) : undefined, '    '));
          lines.push('  end tell', 'end tell');
          await runAppleScript(lines.join('\n'));
          return { ok: true, created: name, list, dueDate: args.dueDate ? String(args.dueDate) : null };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'reminder_list',
      description: 'List the names of all reminders in a list (default "Reminders").',
      inputSchema: {
        type: 'object',
        properties: {
          list: { type: 'string', description: 'Reminders list (default "Reminders").' },
        },
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const gate = requireControl(ctx);
        if (!gate.ok) return gate;
        try {
          const out = await runAppleScript(
            `tell application "Reminders"\n  tell list "${listArg(args.list as string | undefined)}"\n    get name of every reminder\n  end tell\nend tell`,
          );
          const items = out
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          return { ok: true, count: items.length, reminders: items };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'reminder_delete',
      description: 'Delete all reminders whose name matches in a list (default "Reminders").',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact reminder name to delete.' },
          list: { type: 'string', description: 'Reminders list (default "Reminders").' },
        },
        required: ['name'],
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const gate = requireControl(ctx);
        if (!gate.ok) return gate;
        const name = String(args.name ?? '').trim();
        if (!name) return { ok: false, error: 'name is required' };
        try {
          await runAppleScript(
            `tell application "Reminders"\n  tell list "${listArg(args.list as string | undefined)}"\n    set targets to every reminder whose name is "${escapeLiteral(name)}"\n    repeat with r in targets\n      delete r\n    end repeat\n  end tell\nend tell`,
          );
          return { ok: true, deleted: name };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
