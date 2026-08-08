import type { ToolDefinition } from '../agent/types.js';
import type { ModelRouter } from '../providers/index.js';
import { refineStep, correctiveTail } from '../refine.js';
import { verifyFile, verdict, readIfExists } from '../verify.js';
import type { VerifyResult } from '../verify.js';

/**
 * `refine_code` — DSPy-style budget-bounded self-refinement over a code edit.
 *
 * Produces a proposed edit for a task, guards the result deterministically with
 * `verify_change` (no model), and on failure feeds the findings back as a
 * corrective tail into a bounded retry (DSPy `max_backtracks=2`). The happy path
 * is a single LM call (guard is CPU); a failed edit costs at most 1–2 extra
 * near-identical completions — ideal for the 8GB-M1-alongside-Blender constraint.
 *
 * The LLM `produce` step is supplied by the caller via a router-backed closure.
 */
export interface RefineCodeInput {
  file: string;
  task: string;
  /** Optional custom producer. When omitted, `router` is used to draft. */
  produce?: (feedback: string | undefined) => Promise<string>;
  /** LLM router used to draft corrections when `produce` is omitted. */
  router?: ModelRouter;
  budget?: number;
}

/** Default LLM-backed producer: asks the model to (re)write the file for `task`,
 *  appending the corrective feedback as a corrective tail on retries. */
function llmProducer(input: RefineCodeInput, router: ModelRouter) {
  return async (feedback: string | undefined): Promise<string> => {
    const system = 'You rewrite a single code file to satisfy a task and any correction feedback. Return ONLY the new file contents (no markdown fences, no commentary).';
    const user = feedback
      ? `Rewrite the file to satisfy: ${input.task}\n\nCurrent contents must be replaced.\n${feedback}`
      : `Write the file contents to satisfy:\n${input.task}`;
    const chat = await router.chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
    return ((chat.content ?? '').trim() || '(empty — model produced no contents)');
  };
}

/**
 * Run a budget-bounded refine of a code file against the deterministic
 * `verify_change` guard. Returns the accepted source, attempts, and whether the
 * guard passed. Does NOT write the file — it returns the accepted source for the
 * caller to apply (or for Jarv to review first).
 */
export async function refineCode(input: RefineCodeInput): Promise<{
  ok: boolean;
  source: string | undefined;
  attempts: number;
  accepted: boolean;
  feedback?: string;
  verify?: VerifyResult | null;
}> {
  // If no custom producer is given, require a router to draft via the LLM.
  const producer = input.produce ?? (input.router ? llmProducer(input, input.router) : undefined);
  if (!producer) {
    return { ok: false, source: undefined, attempts: 0, accepted: false, verify: null };
  }

  let lastStatus: VerifyResult | null = null;
  const result = await refineStep<string>({
    budget: input.budget ?? 2,
    produce: (feedback) => producer(feedback),
    guard: {
      check: async (source) => {
        // Deterministic, local, CPU — no model cost.
        const verify = await verifyFile(input.file, source);
        lastStatus = verdict(input.file, source, verify);
        if (lastStatus.status === 'pass') return { ok: true };
        const reason = buildReason(lastStatus.status, lastStatus);
        return { ok: false, feedback: correctiveTail(source.slice(0, 120), reason) };
      },
    },
  });

  return {
    ok: result.accepted,
    source: result.value,
    attempts: result.attempts,
    accepted: result.accepted,
    feedback: result.feedback,
    verify: lastStatus,
  };
}

function buildReason(status: VerifyResult['status'], v: VerifyResult): string {
  if (status === 'fail') {
    return v.findings.map((f) => f.message).join('; ') + (v.findings[0]?.suggestedFix ? ` Fix hint: ${v.findings[0].suggestedFix}` : '');
  }
  const missing = v.coverage.filter((c) => c.status === 'incomplete').map((c) => `${c.check} (${c.reason ?? 'unsupported'})`).join(', ');
  return `the verification was incomplete — could not prove it clean locally (${missing || 'unsupported checks'}). Aim for provably clean, resolvable local references.`;
}

/** Read a file's current source (helper for building a refine tool/fixture). */
export async function currentSource(file: string): Promise<string | null> {
  return readIfExists(file);
}

/** `refine_code` tool — exposes the refine loop as a Jarv immune-system tool. */
export function refineTools(getRouter?: () => ModelRouter): ToolDefinition[] {
  return [
    {
      name: 'refine_code',
      system: 'immune',
      description:
        'Self-refine a code file against the deterministic verify_change guard: it (a) produces a draft for a task (via the model), (b) verifies it locally with NO model, and on failure feeds the findings back into up to ~2 bounded retries as corrective feedback. Returns the accepted source (not yet written) plus how many attempts it took. Use after code_edit to close the "draft → verify → fix" loop. The happy path costs one LM call; a failed edit costs at most 1–2 extra small calls — RAM-light for running alongside Blender.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Absolute path of the code file to (re)write.' },
          task: { type: 'string', description: 'What the file should do.' },
          budget: { type: 'number', description: 'Max retries after the first draft (default 2).' },
        },
        required: ['file', 'task'],
      },
      handler: async (args: Record<string, unknown>) => {
        const file = String(args.file ?? '').trim();
        const task = String(args.task ?? '').trim();
        if (!file || !task) return { ok: false, error: 'file and task are required' };
        const router = getRouter?.();
        if (!router) return { ok: false, error: 'refine_code requires a model router to draft the file' };
        const res = await refineCode({ file, task, router, budget: typeof args.budget === 'number' ? args.budget : 2 });
        return {
          ok: res.ok,
          accepted: res.accepted,
          attempts: res.attempts,
          file,
          source: res.source,
          verifyStatus: res.verify?.status,
          verifyFindings: res.verify?.findings?.length ?? 0,
          note: res.accepted
            ? `Accepted after ${res.attempts} attempt(s) — draft not written, apply/verify it.`
            : `Not accepted after ${res.attempts} attempt(s) — inspect the verify feedback and fix manually.`,
        };
      },
    },
  ];
}
