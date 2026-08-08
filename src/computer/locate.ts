/**
 * Coordinate localization for computer use (JARVIS blueprint §C1 / P1, ported
 * from Anthropic's `computer-use-best-practices` pattern; MIT).
 *
 * The core "see → click" problem: a vision model observes a screenshot that may
 * have been resized (or is interpreted in normalized 0..1 coordinates), so a
 * point it predicts on that image must be translated back to **real** screen
 * pixels before it can drive a real click (CGEvent/System Events). These helpers
 * are pure and injectable so the round-trip math is unit-testable without a
 * screen or a model.
 *
 * All coordinates are top-left origin (x right, y down), matching macOS
 * screen coordinates returned by System Events / CGEventGetLocation 0.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface NormalizedBox {
  /** Vision/CoreML normalized box: origin bottom-left, each in [0,1]. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The width the vision model is told the image is ("sent" width). If a resize
 * target is supplied we use it; otherwise point-mapping is a no-op scale (1:1)
 * and the caller already has real pixels.
 */
export function sentWidth(realW: number, targetW: number): number {
  return Math.min(targetW, realW);
}

/** Height implied by the sent width, preserving aspect ratio. */
export function sentHeight(realW: number, realH: number, targetW: number): number {
  const sw = sentWidth(realW, targetW);
  return Math.max(1, Math.round((realH * sw) / Math.max(1, realW)));
}

/**
 * Translate a point predicted on the *sent* (possibly downscaled) image back to
 * real screen pixels. This is the inverse of the downscale the caller applied
 * when sending the image to the model, so a model click lands where the model
 * actually saw the target. Clamped to the real screen bounds.
 */
export function mapPointToReal(pt: Point, sentW: number, sentH: number, realW: number, realH: number): Point {
  const x = clamp((pt.x / Math.max(1, sentW)) * realW, 0, realW - 1);
  const y = clamp((pt.y / Math.max(1, sentH)) * realH, 0, realH - 1);
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Convert a normalized [0,1] point (top-left origin) to real screen pixels.
 * Useful when the model reports a point in fractional image coordinates.
 */
export function normalizeToReal(pt: Point, realW: number, realH: number): Point {
  return {
    x: Math.round(clamp(pt.x, 0, 1) * (realW - 1)),
    y: Math.round(clamp(pt.y, 0, 1) * (realH - 1)),
  };
}

/**
 * Center of a normalized bounding box (as returned by macOS Vision, origin
 * bottom-left) in real screen pixels — i.e. the pixel to click to hit that
 * element. clamps the box into the image first.
 */
export function bboxToPoint(box: NormalizedBox, realW: number, realH: number): Point {
  const cx = clamp((box.x + box.w / 2), 0, 1);
  // Vision Y is bottom-up; flip to top-down (macOS screen top-left origin).
  const relFromTop = 1 - clamp(box.y + box.h / 2, 0, 1);
  return {
    x: Math.round(cx * (realW - 1)),
    y: Math.round(relFromTop * (realH - 1)),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
