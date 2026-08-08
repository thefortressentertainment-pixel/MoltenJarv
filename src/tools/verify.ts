import type { ToolDefinition } from '../agent/types.js';
import { verifyFileOnDisk } from '../verify.js';

/**
 * `verify_change` — deterministic 3-state code verification (skylos harvest).
 *
 * Verifies an AI-edited file for hallucinated/phantom references WITHOUT
 * executing code or invoking an LLM judge. Returns pass / fail / incomplete with
 * a coverage block explaining which proofs completed. Reads only — never runs,
 * never writes, never requires consent.
 *
 * This is the deterministic spine the LLM judge attaches to: a clean `pass` is a
 * genuinely determinate green; `incomplete` is a NON-pass (do not claim clean).
 */
export function verifyTools(): ToolDefinition[] {
  return [
    {
      name: 'verify_change',
      system: 'immune',
      description:
        'Deterministically verify a code file you just edited for phantom/hallucinated local imports (references to names the referenced module does not export). Runs statically — no execution, no model in the loop — and returns pass / fail / incomplete with a coverage block. Use after code_edit and BEFORE relying on self_review: a pass means the local symbol graph is clean; incomplete means the proof could not be completed (do not claim clean). Requires an editable file path.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Absolute path to the code file to verify.' },
        },
        required: ['file'],
      },
      handler: async (args: Record<string, unknown>) => {
        const file = String(args.file ?? '').trim();
        if (!file) return { ok: false, error: 'file is required' };
        try {
          const result = await verifyFileOnDisk(file);
          return { ok: true, ...result, status: result.status };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
