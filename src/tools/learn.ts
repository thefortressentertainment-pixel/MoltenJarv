import path from 'node:path';
import type { ToolDefinition, ToolContext } from '../agent/types.js';
import { dataHome } from '../config/defaults.js';
import { saveSkill, skillExists, shouldLearn } from '../learn.js';

/**
 * `learn_skill` — self-learning skill caching (JARVIS blueprint §C6).
 *
 * After Jarv completes a task it can verify as genuinely successful, it records
 * a reusable procedure as a SKILL.md in the skills dir, so future similar tasks
 * follow the proven approach. Skilled procedures are advisory instructions only;
 * the reflex + consent gates still apply to every tool they reference.
 *
 * Risk: writes a file under ~/.jarv-genie/skills (write-local) → consent-gated,
 * but reversible and non-external, so a plain `consequential` tool.
 */
export function learnTools(skillsDir?: string): ToolDefinition[] {
  const dir = skillsDir ?? path.join(dataHome(), 'skills');
  return [
    {
      name: 'learn_skill',
      system: 'autonomic',
      description:
        'Record a reusable procedure you learned from a task you just completed successfully, so future similar tasks follow the proven approach. Writes a SKILL.md into the skills directory (loaded into every future prompt). Use AFTER you have actually completed and verified a task — not for hypotheticals. Provide a short name, a one-line description, and the procedure body (clear numbered steps or rules). Optionally pass judgeScore (from the judge tool, -1..+1); a low score refuses to learn from a run that was not a clear success.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Short procedure title, e.g. "generate-investor-digest" (used as the skill folder name).',
          },
          description: {
            type: 'string',
            description: 'One-line description of what this skill does and when to apply it.',
          },
          procedure: {
            type: 'string',
            description: 'The reusable procedure: clear numbered steps or rules, in markdown. Be precise and self-contained.',
          },
          judgeScore: {
            type: 'number',
            description: 'Optional judge score (-1..+1) for the task you just completed. Below the learn threshold it refuses.',
          },
        },
        required: ['name', 'description', 'procedure'],
      },
      consequential: true,
      handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
        const name = String(args.name ?? '').trim();
        const description = String(args.description ?? '').trim();
        const procedure = String(args.procedure ?? '').trim();
        if (!name || !description || !procedure) {
          return { ok: false, error: 'name, description, and procedure are all required' };
        }
        const judgeScore = args.judgeScore === undefined ? undefined : Number(args.judgeScore);
        if (judgeScore !== undefined && !Number.isFinite(judgeScore)) {
          return { ok: false, error: 'judgeScore must be a number' };
        }
        const gate = shouldLearn({ judgeScore });
        if (!gate.learn) {
          return { ok: false, error: `refused to learn: ${gate.reason}` };
        }
        try {
          const existed = skillExists(dir, name);
          const result = saveSkill(dir, { name, description }, procedure);
          return {
            ok: true,
            skill: result.slug,
            skillPath: result.path,
            overwrote: result.overwrote,
            loaded: !existed ? 'will be loaded into future prompts from startup' : 'existing skill overwritten',
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
