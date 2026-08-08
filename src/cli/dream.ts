import type { AgentContext } from './index.js';
import { runDream, shouldDream, DreamLockFile, type DreamOptions } from '../memory/dream.js';

/**
 * `jarv-genie dream [--force] [--min-count N] [--no-wait]`
 *
 * Run a memory consolidation pass now. Without --force, the same cheapest-first
 * gates that guard the scheduled run still apply (so a manual run behaves like
 * the background one unless the user insists).
 */
export async function runDreamCommand(ctx: AgentContext, argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const opts: DreamOptions = {};
  const minCount = argv.find((a, i) => argv[i - 1] === '--min-count');
  if (minCount) opts.minCount = Number(minCount);

  if (!force) {
    const lock = new DreamLockFile(`${ctx.config.memory.dir}/.dream-lock`);
    const facts = await ctx.memory.factStore.list();
    const gate = await shouldDream(lock, facts, opts);
    if (!gate.go) {
      process.stdout.write(`skipped — ${gate.reason} (use --force to override)\n`);
      return;
    }
  }
  if (force) {
    opts.minHours = 0; // bypass the time gate so a manual consolidation always runs
    opts.minCount = 1;
  }

  const result = await runDream(ctx.memory, ctx.router, ctx.config, opts);
  if (!result.ran) {
    process.stdout.write(`no consolidation — ${result.reason}\n`);
    return;
  }
  process.stdout.write(
    `consolidated: ${result.before} facts → ${result.after} (dropped ${result.dropped})\n`,
  );
}
