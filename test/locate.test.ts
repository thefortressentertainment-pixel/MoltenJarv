import assert from 'node:assert';
import { test } from 'node:test';
import {
  bboxToPoint,
  mapPointToReal,
  normalizeToReal,
  sentHeight,
  sentWidth,
} from '../src/computer/locate.js';

test('sentWidth caps at the real width and sentHeight preserves aspect', () => {
  assert.strictEqual(sentWidth(1920, 1024), 1024);
  assert.strictEqual(sentWidth(1920, 99999), 1920, 'target larger than real → use real');
  // 1920x1080 sent at 1024 wide → height 1024*1080/1920 = 576
  assert.strictEqual(sentHeight(1920, 1080, 1024), 576);
  assert.strictEqual(sentHeight(1920, 1080, 1920), 1080, 'sent at full res → same height');
});

test('mapPointToReal round-trips a downscaled coordinate back to real pixels', () => {
  // Real 1920x1080 sent at 1024x576; a point at sent (512, 288) (center) must
  // round-trip to roughly real (960, 540).
  const pt = mapPointToReal({ x: 512, y: 288 }, 1024, 576, 1920, 1080);
  assert.strictEqual(pt.x, 960);
  assert.strictEqual(pt.y, 540);
});

test('mapPointToReal is identity at 1:1 sent scale', () => {
  const pt = mapPointToReal({ x: 100, y: 200 }, 1920, 1080, 1920, 1080);
  assert.deepStrictEqual(pt, { x: 100, y: 200 });
});

test('mapPointToReal clamps out-of-bounds predictions into the screen', () => {
  const pt = mapPointToReal({ x: 5000, y: -50 }, 1024, 576, 1920, 1080);
  assert.strictEqual(pt.x, 1919);
  assert.strictEqual(pt.y, 0);
});

test('normalizeToReal maps [0,1] points to pixels and ignores the zero corner', () => {
  assert.deepStrictEqual(normalizeToReal({ x: 0, y: 0 }, 1920, 1080), { x: 0, y: 0 });
  assert.deepStrictEqual(normalizeToReal({ x: 1, y: 1 }, 1920, 1080), { x: 1919, y: 1079 });
  assert.deepStrictEqual(normalizeToReal({ x: 0.5, y: 0.5 }, 1920, 1080), { x: 960, y: 540 });
});

test('bboxToPoint flips Vision bottom-up boxes to top-down screen pixels', () => {
  // A box occupying the whole image → center pixel.
  const full = bboxToPoint({ x: 0, y: 0, w: 1, h: 1 }, 1920, 1080);
  assert.deepStrictEqual(full, { x: 960, y: 540 });

  // A box at the TOP of the image in Vision (y near 1) should map to a SMALL
  // screen y (top is y=0). Box center at Vision y=0.9 (near top) → screen y near 0.
  const top = bboxToPoint({ x: 0.5, y: 0.9, w: 0.1, h: 0.1 }, 1000, 1000);
  // cx = 0.5+0.05 = 0.55 → 0.55*999 = 549.45 → 549; relFromTop = 1-0.95 = 0.05 → 49.95 → 50
  assert.strictEqual(top.x, 549);
  assert.strictEqual(top.y, 50);
});
