/**
 * The Cortex judge loop, ported to Jarv (see docs/cortex-harvest-plan.md).
 *
 * The transferable idea from `qibin0506/Cortex/train_ppo.py` is a **hybrid,
 * decomposable, explainable score**: deterministic checks anchor the score
 * (cheap, objective, cannot fail closed unreasonably) and an LLM judge supplies
 * only the subjective "was this good work" component on top. The judge must end
 * its reply with a strict parseable `<score>N</score>` tag; everything before it
 * is freeform critique. Scores are clamped and decompose so a low total tells
 * Jarv *which* component failed.
 *
 * The LLM judge is injectable (`judge` option) so logic is unit-testable without
 * a live endpoint; the production wiring supplies a call against the configured
 * primary provider (see src/tools/judge.ts).
 */

/** Deterministic dimensions of the score — each contributes a bounded number. */
export interface DeterministicScores {
  /** Did the work follow the task/contract? 0 = no, 1 = fully. */
  compliance: number;
  /** Did the work demonstrably finish (claimed-done-when-done)? 0..1. */
  completeness: number;
  /** True when a structural/contract break short-circuits the LLM judge. */
  fatal: boolean;
  /** When fatal is true, why (short human string). */
  fatalReason?: string;
}

export interface JudgeResult {
  /** Decomposed total = compliance*W1 + completeness*W2 + judgeScore*W_J. */
  total: number;
  compliance: number;
  completeness: number;
  /** Weighted judge signal (0.0 when the judge was skipped or failed). */
  judgeScore: number;
  /** When true the judge call was skipped (fatal) or failed (degraded). */
  judgeSkipped: boolean;
  /** True when the judge call failed and the review is flagged inconclusive. */
  inconclusive: boolean;
  fatal: boolean;
  fatalReason?: string;
  /** Freeform brief when the judge produced one. */
  note?: string;
}

export interface JudgeOptions {
  /** Weight of the deterministic compliance component (default 0.4). */
  complianceWeight?: number;
  /** Weight of the deterministic completeness component (default 0.4). */
  completenessWeight?: number;
  /** Weight of the LLM judge signal (default 0.2). */
  judgeWeight?: number;
  /** Optional injectable LLM judge. Must return a clamped parseable score. */
  judge?: (input: { task: string; work: string; criteria?: string }) => Promise<{ score: number; note?: string }>;
}

const COMPLIANCE_WEIGHT = 0.4;
const COMPLETENESS_WEIGHT = 0.4;
const JUDGE_WEIGHT = 0.2;

/**
 * A scoring context anchored by deterministic checks; the judge is only invoked
 * when nothing fatal was found (P5: deterministic-first, judge-last).
 */
export async function judgeOutput(
  det: DeterministicScores,
  task: string,
  work: string,
  opts: JudgeOptions = {},
): Promise<JudgeResult> {
  const wComp = opts.complianceWeight ?? COMPLIANCE_WEIGHT;
  const wCompl = opts.completenessWeight ?? COMPLETENESS_WEIGHT;
  const wJudge = opts.judgeWeight ?? JUDGE_WEIGHT;
  const compliance = clamp01(det.compliance);
  const completeness = clamp01(det.completeness);

  // Fatal contract break: skip the LLM judge entirely and score deterministically
  // (mirrors Cortex routing format-fatal samples away from the reward model).
  if (det.fatal) {
    const total = round(wComp * compliance + wCompl * completeness);
    return {
      total,
      compliance: round(compliance),
      completeness: round(completeness),
      judgeScore: 0,
      judgeSkipped: true,
      inconclusive: false,
      fatal: true,
      fatalReason: det.fatalReason,
    };
  }

  const judgeFn = opts.judge;
  if (!judgeFn) {
    // No judge configured: deterministic-only score, but not "failed".
    const total = round(wComp * compliance + wCompl * completeness);
    return {
      total,
      compliance: round(compliance),
      completeness: round(completeness),
      judgeScore: 0,
      judgeSkipped: true,
      inconclusive: false,
      fatal: false,
    };
  }

  // Subjective component (P4: graceful degradation — a failed judge yields a
  // neutral 0.0 and flags the review inconclusive instead of poisoning the trend).
  let judgeScore = 0;
  let judgeSkipped = false;
  let inconclusive = false;
  let note: string | undefined;
  try {
    const res = await judgeFn({ task, work });
    judgeScore = res.score * wJudge;
    note = res.note;
  } catch {
    inconclusive = true;
    judgeSkipped = true;
  }

  const total = round(compliance * wComp + completeness * wCompl + judgeScore);
  return {
    total,
    compliance: round(compliance),
    completeness: round(completeness),
    judgeScore: round(judgeScore),
    judgeSkipped,
    inconclusive,
    fatal: false,
    note,
  };
}

/** Parse a strict `<score>N</score>` (or bare numeric) reply, clamped to [-1,1]. */
export function parseJudgeScore(text: string): { score: number; note: string } {
  const note = text.replace(/<score>[\-\d\.]+<\/score>/i, '').trim().slice(0, 500);
  const m = text.match(/<score>\s*([\-\d\.]+)\s*<\/score>/i);
  const raw = m ? Number(m[1]) : undefined;
  if (raw !== undefined && Number.isFinite(raw)) {
    return { score: clamp01(raw), note };
  }
  const bare = text.trim().match(/^\s*([\-\d\.]+)\s*$/);
  const b = bare ? Number(bare[1]) : undefined;
  if (b !== undefined && Number.isFinite(b)) return { score: clamp01(b), note };
  return { score: 0, note: '(no parseable score)' };
}

function clamp01(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
