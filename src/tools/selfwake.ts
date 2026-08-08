import type { ToolDefinition } from '../agent/types.js';
import { WakeStore } from '../selfwake.js';

/**
 * Self-wake tools: let the agent declare "wake me later" instead of idling, and
 * "wake me when this background job finishes." The scheduler's tick calls
 * `WakeStore#pollDue` so due wakes re-invoke the agent.
 */
export function selfWakeTools(stateDir: string): ToolDefinition[] {
  const store = new WakeStore(stateDir);
  return [
    {
      name: 'sleep_until',
      system: 'autonomic',
      description:
        'Suspend until a future time (ISO 8601) or a delay in seconds, then be re-invoked automatically. Use to defer follow-up work instead of idling. Returns a wake id.',
      inputSchema: {
        type: 'object',
        properties: {
          at: { type: 'string', description: 'ISO 8601 time to wake, e.g. "2026-08-08T12:00:00".' },
          seconds: { type: 'number', description: 'Wake after this many seconds. Alternative to `at`.' },
          prompt: { type: 'string', description: 'What to do when the wake fires.' },
        },
        required: ['prompt'],
      },
      handler: async (args) => {
        const prompt = String(args.prompt ?? '').trim();
        if (!prompt) return { ok: false, error: 'sleep_until requires a prompt' };
        let dueAt: number;
        if (args.seconds !== undefined) {
          const secs = Number(args.seconds);
          if (!Number.isFinite(secs) || secs < 0) return { ok: false, error: 'seconds must be >= 0' };
          dueAt = Date.now() + secs * 1000;
        } else if (args.at) {
          const t = Date.parse(String(args.at));
          if (!Number.isFinite(t)) return { ok: false, error: `unparseable time "${args.at}"` };
          dueAt = t;
        } else {
          return { ok: false, error: 'sleep_until requires `at` or `seconds`' };
        }
        const id = await store.schedule(prompt, dueAt);
        return { ok: true, id, wakeAt: new Date(dueAt).toISOString() };
      },
    },
    {
      name: 'wake_on_job',
      system: 'autonomic',
      description:
        'Register to be re-invoked when a background job/task completes. Pass the job handle that run_shell/background returned. Returns a wake id.',
      inputSchema: {
        type: 'object',
        properties: {
          job: { type: 'string', description: 'The background job handle to wait on.' },
          prompt: { type: 'string', description: 'What to do when the job completes.' },
        },
        required: ['job', 'prompt'],
      },
      handler: async (args) => {
        const job = String(args.job ?? '').trim();
        const prompt = String(args.prompt ?? '').trim();
        if (!job || !prompt) return { ok: false, error: 'wake_on_job requires a job and prompt' };
        // A job wake is due essentially immediately-ish; the scheduler re-runs and
        // the agent checks completion. We schedule a short future wake keyed by job.
        const id = await store.schedule(prompt, Date.now() + 30_000, job);
        return { ok: true, id, job };
      },
    },
    {
      name: 'wake_cancel',
      system: 'autonomic',
      description: 'Cancel a pending wake by its id (from sleep_until or wake_on_job).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The wake id to cancel.' } },
        required: ['id'],
      },
      handler: async (args) => {
        const id = String(args.id ?? '').trim();
        if (!id) return { ok: false, error: 'wake_cancel requires id' };
        const removed = await store.cancel(id);
        return { ok: removed, removed };
      },
    },
  ];
}
