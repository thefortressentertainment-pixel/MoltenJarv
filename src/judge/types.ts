/**
 * Review log types — the persistent "taste/review" store behind Jarv's
 * scored self-review (Cortex harvest plan, P3). Each entry records one
 * judgment of a task or self-improvement, decomposed into objective and
 * judge components so a low total tells Jarv *which* component failed.
 */

export interface ReviewEntry {
  id: string;
  /** ISO timestamp the review was recorded. */
  ts: string;
  /** What was reviewed: a task, a self-improvement change, etc. */
  kind: 'known' | string;
  /** Short human label, e.g. "scored self-review 2026-08-08". */
  label?: string;
  /** Deterministic pieces (Jarv's real checks), each in [-n, n] or absolute. */
  compliance: number;
  completeness: number;
  /** Weighted judge score from the LLM judge (0.0 on failure / not scored). */
  judgeScore: number;
  /** `compliance + completeness + judgeScore` fallback when pieces aren't summed upstream. */
  total: number;
  /** True when a structural/contract break short-circuited the judge. */
  fatal: boolean;
  /** True when the judge call failed and the review was marked inconclusive. */
  inconclusive?: boolean;
  /** One-line brief from the judge, or a note. */
  note?: string;
  /** Kind-specific payload (e.g. the work preview under review). */
  detail?: string;
}
