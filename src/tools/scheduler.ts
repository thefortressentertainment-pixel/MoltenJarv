import type { ToolDefinition } from '../agent/types.js';
import { loadAgentConfig, saveAgentConfig, newScheduleId } from '../scheduler/index.js';
import { parseCron } from '../scheduler/cron.js';

/**
 * Scheduler tools: recurring alarms / reminders / briefings. The always-on
 * agent daemon ticks every 30s and fires any schedule whose cron matches, so a
 * "every Saturday at 7am" alarm is just `schedule_add` with cron "0 7 * * 6".
 */

export function schedulerTools(): ToolDefinition[] {
  return [
    {
      name: 'schedule_add',
      description:
        'Create a recurring scheduled task that runs the agent at a cron time. Great for alarms, reminders, and briefings (e.g. "0 7 * * 6" = every Saturday 07:00). Pass --flags via notify/speak options. Returns the schedule id.',
      inputSchema: {
        type: 'object',
        properties: {
          cron: { type: 'string', description: '5-field cron expression, e.g. "0 7 * * 6".' },
          prompt: { type: 'string', description: 'What to do when it fires (shown to the agent).' },
          notify: { type: 'boolean', description: 'Send a macOS notification when it fires (default true).' },
          speak: { type: 'boolean', description: 'Speak the result aloud when it fires.' },
        },
        required: ['cron', 'prompt'],
      },
      consequential: true,
      handler: async (args: Record<string, unknown>) => {
        const cron = String(args.cron ?? '').trim();
        const prompt = String(args.prompt ?? '').trim();
        if (!cron || !prompt) return { ok: false, error: 'schedule_add requires cron and prompt' };
        try {
          parseCron(cron);
        } catch (err) {
          return { ok: false, error: `invalid cron: ${err instanceof Error ? err.message : String(err)}` };
        }
        const cfg = loadAgentConfig();
        const id = newScheduleId();
        cfg.schedules.push({
          id,
          cron,
          prompt,
          notify: args.notify !== false,
          speak: args.speak === true,
        });
        saveAgentConfig(cfg);
        return { ok: true, id, cron, prompt, note: 'picked up by the agent daemon within ~30s' };
      },
    },
    {
      name: 'schedule_list',
      description: 'List all scheduled tasks with their cron and prompt.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const cfg = loadAgentConfig();
        return { ok: true, schedules: cfg.schedules };
      },
    },
    {
      name: 'schedule_remove',
      description: 'Remove a scheduled task by its id (from schedule_add) or by its exact prompt text.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The schedule id to remove.' },
        },
        required: ['id'],
      },
      consequential: true,
      handler: async (args: Record<string, unknown>) => {
        const id = String(args.id ?? '').trim();
        if (!id) return { ok: false, error: 'schedule_remove requires id' };
        const cfg = loadAgentConfig();
        const before = cfg.schedules.length;
        cfg.schedules = cfg.schedules.filter((s) => s.id !== id && s.prompt !== id);
        if (cfg.schedules.length === before) return { ok: false, error: `no schedule matches "${id}"` };
        saveAgentConfig(cfg);
        return { ok: true, removed: id };
      },
    },
  ];
}
