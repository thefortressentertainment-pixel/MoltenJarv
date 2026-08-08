import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendDelivery,
  verifyChain,
  backfillChain,
  logPath,
  deliveryLogTools,
} from '../src/tools/deliverylog.js';

async function withHome(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-delivery-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    await fn();
  } finally {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  }
}

test('appendDelivery writes chained entries and verifyChain confirms the chain', async () => {
  await withHome(async () => {
    const r1 = await appendDelivery('Shipped the investor digest', 'investor-digest', 'artifact at Digests/2026-08-04');
    assert.strictEqual(r1.ok, true);
    assert.match(r1.hash, /^[0-9a-f]{64}$/);

    const r2 = await appendDelivery('Posted trust signal', 'social', 'post 831e7712 live');
    assert.strictEqual(r2.ok, true);
    assert.notStrictEqual(r2.hash, r1.hash);

    const chain = await verifyChain();
    assert.strictEqual(chain.ok, true);
    assert.strictEqual(chain.count, 2);
    assert.strictEqual(chain.root, r2.hash);
    assert.strictEqual(chain.manifestRoot, r2.hash);

    const raw = readFileSync(logPath(), 'utf8');
    assert.match(raw, /- \*\*Hash:\*\* [0-9a-f]{64}/);
    assert.ok((raw.match(/- \*\*Hash:\*\*/g) ?? []).length === 2, 'each entry carries a hash link');
  });
});

test('tampering with an entry breaks the chain at that entry', async () => {
  await withHome(async () => {
    await appendDelivery('entry one', 'other', 'ok');
    await appendDelivery('entry two', 'other', 'ok');

    const p = logPath();
    const tampered = readFileSync(p, 'utf8').replace('entry one', 'entry ONE (edited)');
    writeFileSync(p, tampered);

    const chain = await verifyChain();
    assert.strictEqual(chain.ok, false);
    assert.strictEqual(chain.brokenAt, 1);
  });
});

test('backfillChain hashes a pre-existing un-chained log and verifies', async () => {
  await withHome(async () => {
    mkdirSync(path.dirname(logPath()), { recursive: true });
    writeFileSync(
      logPath(),
      '# Header\n\n## Log\n\n## 2026-08-04 18:10 CDT\n- **Delivered:** old entry\n- **Category:** other\n- **Outcome:** done\n',
    );

    const res = await backfillChain();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.entries, 1);

    const raw = readFileSync(logPath(), 'utf8');
    assert.match(raw, /- \*\*Hash:\*\* [0-9a-f]{64}/);

    const chain = await verifyChain();
    assert.strictEqual(chain.ok, true);
    assert.strictEqual(chain.count, 1);
  });
});

test('append after backfill extends the same chain', async () => {
  await withHome(async () => {
    mkdirSync(path.dirname(logPath()), { recursive: true });
    writeFileSync(logPath(), '# Header\n\n## 2026-08-04 18:10 CDT\n- **Delivered:** first\n- **Category:** other\n- **Outcome:** ok\n');
    const { root: firstRoot } = await backfillChain();

    const r2 = await appendDelivery('second', 'other', 'ok');
    assert.strictEqual(r2.ok, true);
    const chain = await verifyChain();
    assert.strictEqual(chain.ok, true);
    assert.strictEqual(chain.count, 2);
    assert.notStrictEqual(chain.root, firstRoot);
    assert.strictEqual(chain.root, r2.hash);
  });
});

test('deliverylog tools are exposed; verify is read-only and returns an attestation', async () => {
  await withHome(async () => {
    const names = deliveryLogTools().map((t) => t.name);
    assert.ok(names.includes('log_delivery'));
    assert.ok(names.includes('deliverylog_verify'));

    const verify = deliveryLogTools().find((t) => t.name === 'deliverylog_verify')!;
    assert.ok(!verify.consequential, 'verify is read-only');

    const res = (await verify.handler({}, {})) as { ok: boolean; count: number; attestation: string };
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.count, 0);
    assert.match(res.attestation, /chain root/);
  });
});
