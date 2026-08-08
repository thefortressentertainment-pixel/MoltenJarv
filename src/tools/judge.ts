import type { ToolDefinition, ToolContext } from '../agent/types.js';
import { judgeOutput, type DeterministicScores } from '../judge/judge.js';
import { makeLlmJudge, type JudgeCall } from '../judge/llmJudge.js';
import { ReviewStore } from '../judge/store.js';
import { resolveApiKey } from '../config/index.js';

/**
 * The `judge` tool — the Cortex `reward_func` ported to a Jarv organ (P1).
 * Scores a piece of work with a decomposable `{compliance, completeness,
 * judgeScore, total}` and persists each verdict to the review log (P3), so
 * Jarv's self-optimization becomes measurable over time rather than vibes.
 *
 * Risk: `external` — it calls the configured LLM provider but writes nothing
 * outside the review log, so it is non-consequential (no consent gate).
 */
export function judgeTools(reviewsFile?: string): ToolDefinition[] {
  const store = reviewsFile ? new ReviewStore(reviewsFile) : null;

  /** Deterministic checks = objective, cheap, never delegate to the LLM. */
  function deterministicScore(input: {
    task: string;
    work: string;
    criteria?: string;
    claimComplete: boolean;
  }): DeterministicScores {
    const taskOk = Boolean(input.task.trim());
    const workOk = Boolean(input.work.trim());
    const criteriaOk = Boolean(input.criteria?.trim());

    // A structural gap (empty work, missing task, or claim-done-when-unfinished)
    // is a contract break → fatal, judge skipped (Cortex's format-fatal gate).
    if (!workOk) return { compliance: 0, completeness: 0, fatal: true, fatalReason: 'work is empty' };
    if (!taskOk) return { compliance: 0.5, completeness: 0.5, fatal: true, fatalReason: 'task is empty' };
    if (input.claimComplete && workOk && !criteriaOk) {
      // Claiming completion with no criteria to satisfy is a soft concern, not fatal.
    }
    // Compliance: criteria present and satisfied-ish heuristics. We default
    // compliance to full only when work non-empty AND (no criteria, or work is
    // non-trivial). Completeness matches the agent's own claim when present.
    const compliance = criteriaOk && input.work.trim().length < 20 ? 0.5 : 1;
    const completeness = input.claimComplete ? 1 : 0.8;
    return { compliance, completeness, fatal: false };
  }

  return [
    {
      name: 'judge',
      system: 'autonomic',
      description:
        'Score a piece of work (a task result, a self-improvement change, email, digest, etc.) on a -1..+1 scale, decomposed into compliance (followed the task/criteria), completeness (finished what it claimed), and a judge signal. Returns the components, the weighted total, and a brief critique. Persists each verdict to the review log so quality trends are measurable. Use to self-optimize: judge your own delivered work and compare totals across reviews.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What was asked / the task being judged.' },
          work: { type: 'string', description: 'The delivered work to score.' },
          criteria: {
            type: 'string',
            description: 'Optional explicit success criteria the work should satisfy.',
          },
          claimComplete: {
            type: 'boolean',
            description: 'Whether the agent claims this work is complete (default true).',
          },
          label: {
            type: 'string',
            description: 'Optional short label for the review log entry.',
          },
        },
        required: ['task', 'work'],
      },
      risk: 'read',
      handler: async (args, ctx: ToolContext) => {
        const task = String(args.task ?? '').trim();
        const work = String(args.work ?? '').trim();
        const criteria = args.criteria ? String(args.criteria).trim() : undefined;
        const claimComplete = args.claimComplete !== false;
        const label = args.label ? String(args.label).trim() : undefined;

        const det = deterministicScore({ task, work, criteria, claimComplete });

        // Wire the LLM judge to the configured primary provider.
        const primary = ctx.config.providers.primary;
        const key = resolveApiKey(primary) ?? 'not-set';
        const judgeFn = makeLlmJudge(primary, key);

        const result = await judgeOutput(det, task, work, {
          judge: (input: JudgeCall) => judgeFn({ task: input.task, work: input.work, criteria: criteria ?? input.criteria }),
        });

        let reviewId: string | undefined;
        if (store) {
          const entry = await store.add({
            kind: 'task',
            label,
            compliance: result.compliance,
            completeness: result.completeness,
            judgeScore: result.judgeScore,
            total: result.total,
            fatal: result.fatal,
            inconclusive: result.inconclusive,
            note: result.note,
            detail: work.slice(0, 200),
          });
          reviewId = entry.id;
        }

        return {
          ok: true,
          ...result,
          reviewId,
          persisted: Boolean(store),
          scale: '-1..+1',
        };
      },
    },
  ];
}
