import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../agent/types.js';
import { ReviewStore } from '../judge/store.js';

/**
 * Self-review: Jarv runs its own health checks, reads its optimization plan, and
 * reports the taste/review trend (from the P3 review log) so it can genuinely
 * deliberate on how to improve itself (the "work on yourself in VSCodium" flow).
 * Health checks are deterministic — the model just reads the result and proposes
 * the next step.
 */

const execFileAsync = promisify(execFile);
const REPO = '/Users/tfe/jarv-genie';
const PLAN = path.join(REPO, 'docs', 'optimization-plan.md');

interface TestResult {
  ok: boolean;
  summary: string;
}

async function run(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  try {
    const res = await execFileAsync(command, args, { cwd: REPO, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, output: res.stdout.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: (e.stdout ?? '') + (e.stderr ?? '').slice(0, 1500) };
  }
}

function parseTestSummary(out: string): string {
  const m = out.match(/tests\s+(\d+)[\s\S]*?pass\s+(\d+)[\s\S]*?fail\s+(\d+)/);
  if (m) return `tests ${m[1]} | pass ${m[2]} | fail ${m[3]}`;
  const short = out.split('\n').slice(-4).join('\n').trim();
  return short || '(no summary)';
}

async function runTests(): Promise<TestResult> {
  // Run the suite but exclude this tool's own test file to avoid recursion.
  let files: string[];
  try {
    const dir = path.join(REPO, 'test');
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts') && f !== 'selfreview.test.ts')
      .map((f) => path.join('test', f));
  } catch {
    files = ['test'];
  }
  const res = await run('npx', ['tsx', '--test', ...files], 240_000);
  return { ok: res.ok, summary: res.ok ? parseTestSummary(res.output) : `FAILED:\n${res.output.slice(0, 600)}` };
}

async function runTypecheck(): Promise<TestResult> {
  const res = await run('npm', ['run', 'typecheck'], 120_000);
  return { ok: res.ok, summary: res.ok ? 'typecheck clean' : `typecheck errors:\n${res.output.slice(0, 600)}` };
}

export function readPlan(): { exists: boolean; openItems: string[] } {
  try {
    const text = fs.readFileSync(PLAN, 'utf8');
    const openItems = text
      .split('\n')
      .filter((l) => /^\s*- \[[ ~]\]/.test(l))
      .map((l) => l.trim().replace(/^\s*-\s*\[[ ~]\]\s*/, ''));
    return { exists: true, openItems };
  } catch {
    return { exists: false, openItems: [] };
  }
}

/** Read the taste/review trend from the review log. Null when not configured. */
export async function readQuality(reviewsFile?: string): Promise<{
  reviewCount: number;
  latest?: { id: string; ts: string; total: number };
  delta: number | null;
} | null> {
  if (!reviewsFile) return null;
  const store = new ReviewStore(reviewsFile);
  const s = await store.summary();
  return {
    reviewCount: s.count,
    latest: s.latest,
    delta: s.delta,
  };
}

export function selfReviewTools(reviewsFile?: string): ToolDefinition[] {
  return [
    {
      name: 'self_review',
      system: 'autonomic',
      description:
        'Run a self-review: run the test suite and typecheck of the Jarv Genie codebase, read the optimization plan, and report the taste/review trend (recent scores + whether quality is improving). Returns current health, the open optimization items, and the quality trend. Use to deliberate on the next improvement to Jarv itself.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const [tests, typecheck, plan, quality] = await Promise.all([
          runTests(),
          runTypecheck(),
          Promise.resolve(readPlan()),
          readQuality(reviewsFile),
        ]);
        const healthy = tests.ok && typecheck.ok;
        return {
          ok: healthy,
          repo: REPO,
          tests: tests.summary,
          typecheck: typecheck.summary,
          healthy,
          planExists: plan.exists,
          openItems: plan.openItems,
          quality,
          note: 'Open VSCodium at the repo and propose the next change; run self_review again to verify.',
        };
      },
    },
  ];
}
