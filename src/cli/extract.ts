import type { AgentContext } from './index.js';
import { extractFacts, type ExtractOptions } from '../memory/extract.js';

/**
 * `jarv-genie extract "<text>"`
 *
 * Run an automatic durable-fact extraction pass on the given conversation or
 * transcript: the model pulls out memorable facts (preferences, decisions,
 * people, plans) and ADD-s them to memory, skipping near-duplicates of facts
 * Jarv already knows. Fail-open — an extraction error never touches the store.
 */
export async function runExtractCommand(ctx: AgentContext, argv: string[]): Promise<void> {
  const text = argv.join(' ').trim();
  if (!text) {
    process.stdout.write('usage: jarv-genie extract "<conversation or transcript>"\n');
    return;
  }
  const opts: ExtractOptions = {};
  if (text.startsWith('--')) {
    process.stdout.write('usage: jarv-genie extract "<conversation or transcript>"\n');
    return;
  }

  const result = await extractFacts(ctx.memory, ctx.router, text, opts);
  if (!result.ran) {
    process.stdout.write(`no extraction — ${result.reason}\n`);
    return;
  }
  process.stdout.write(`candidates: ${result.candidates.length}\n`);
  for (const add of result.added) process.stdout.write(`  + ${add}\n`);
  for (const skip of result.skipped) process.stdout.write(`  = (already known) ${skip}\n`);
  if (result.added.length === 0 && result.candidates.length > 0) {
    process.stdout.write('  (all candidates were judged duplicate/known)\n');
  }
}
