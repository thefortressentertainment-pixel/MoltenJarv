import assert from 'node:assert';
import { test } from 'node:test';
import { readPage, webTools } from '../src/tools/web.js';
import type { ToolContext } from '../src/agent/types.js';

function withFetchStub(stub: (input: string) => Promise<{ ok: boolean; status: number; text: string }>, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const stubResult = await stub(String(input));
    return {
      ok: stubResult.ok,
      status: stubResult.status,
      text: async () => stubResult.text,
      headers: new Headers(),
    } as unknown as Response;
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test('web_read returns clean text via Jina Reader', async () => {
  await withFetchStub(async (input) => {
    assert.ok(input.startsWith('https://r.jina.ai/'), `expected r.jina.ai URL, got ${input}`);
    assert.ok(input.includes('https://example.com'));
    return { ok: true, status: 200, text: '# Example Domain\n\nThis domain is for use in illustrative examples.' };
  }, async () => {
    const tool = webTools().find((t) => t.name === 'web_read')!;
    const out = await tool.handler({ url: 'https://example.com' }, {} as ToolContext);
    assert.match(out.content, /Example Domain/);
    assert.strictEqual(out.url, 'https://example.com');
    assert.strictEqual(out.truncated, false);
  });
});

test('web_read truncates past max_chars', async () => {
  await withFetchStub(async () => {
    return { ok: true, status: 200, text: 'a'.repeat(2000) };
  }, async () => {
    const tool = webTools().find((t) => t.name === 'web_read')!;
    const out = await tool.handler({ url: 'https://example.com', max_chars: 1000 }, {} as ToolContext);
    assert.strictEqual(out.content.length, 1000);
    assert.strictEqual(out.truncated, true);
  });
});

test('web_read rejects non-http URLs and empty input', async () => {
  await withFetchStub(async () => {
    throw new Error('should not be called');
  }, async () => {
    const tool = webTools().find((t) => t.name === 'web_read')!;
    await assert.rejects(tool.handler({ url: '' }, {} as ToolContext), /requires a url/);
    await assert.rejects(tool.handler({ url: 'file:///etc/passwd' }, {} as ToolContext), /http\(s\) URL/);
    await assert.rejects(tool.handler({}, {} as ToolContext), /requires a url/);
  });
});

test('web_read surfaces upstream HTTP errors', async () => {
  await withFetchStub(async () => {
    return { ok: false, status: 403, text: 'forbidden' };
  }, async () => {
    await assert.rejects(readPage('https://example.com'), /HTTP 403/);
  });
});
