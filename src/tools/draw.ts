import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../agent/types.js';
import { dataHome } from '../config/defaults.js';

/**
 * Drawing tool: generate an image of a shape (square, rectangle, circle,
 * triangle, or text) with ImageMagick and open it on the Mac so the user can
 * see it. Real, verifiable capability — Jarv uses this instead of claiming
 * drawing is impossible.
 */

const execFileAsync = promisify(execFile);

const SHAPES = ['square', 'rectangle', 'circle', 'triangle', 'text'];
const FALLBACK_COLOR = '#ff0000';

/** Keep at most 5 drawings in the workspace so they don't accumulate. */
function pruneOldDrawings(keep = 5): void {
  try {
    const dir = path.join(dataHome(), 'workspace');
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^drawing-.*\.png$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const file of files.slice(keep)) {
      try {
        fs.rmSync(path.join(dir, file.f), { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function validColor(c: string): boolean {
  return /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(c) || /^[a-z]+$/i.test(c);
}

function shapeScript(shape: string, n: number, color: string): string {
  const c = validColor(color) ? color : FALLBACK_COLOR;
  const inset = Math.max(1, Math.round(n / 5));
  void c;  switch (shape) {
    case 'circle': {
      const cx = Math.floor(n / 2);
      return `circle ${cx},${cx} ${cx},${inset}`;
    }
    case 'triangle': {
      const cx = Math.floor(n / 2);
      return `polygon ${cx},${inset} ${inset},${n - inset} ${n - inset},${n - inset}`;
    }
    case 'rectangle':
      return `rectangle ${inset},${Math.floor(inset / 2)} ${n - inset},${n - Math.floor(inset / 2)}`;
    case 'square':
    default:
      return `rectangle ${inset},${inset} ${n - inset},${n - inset}`;
  }
}

export function drawTools(): ToolDefinition[] {
  return [
    {
      name: 'draw_shape',
      description:
        'Draw a shape as an image and open it on the Mac so the user can see it. Shapes: square, rectangle, circle, triangle, text. Use when the user asks you to draw something. Opens the image in Preview (or the app you name).',
      inputSchema: {
        type: 'object',
        properties: {
          shape: { type: 'string', description: 'square, rectangle, circle, triangle, or text.' },
          size: { type: 'number', description: 'Image size in pixels (default 300).' },
          color: { type: 'string', description: 'Fill color, hex like #ff0000 or a name like red (default red).' },
          text: { type: 'string', description: 'Label text (used when shape is text).' },
          app: { type: 'string', description: 'App to open the image in (default Preview).' },
        },
        required: ['shape'],
      },
      consequential: true,
      handler: async (args) => {
        const shape = String(args.shape ?? '').trim().toLowerCase();
        if (!SHAPES.includes(shape)) return { ok: false, error: `unsupported shape "${shape}"; use ${SHAPES.join(', ')}` };
        const n = Math.max(64, Math.min(1024, Math.trunc(Number(args.size ?? 300) || 300)));
        const color = String(args.color ?? '').trim() || FALLBACK_COLOR;
        const out = path.join(process.env.HOME ?? '', '.jarv-genie', 'workspace', `drawing-${Date.now().toString(36)}.png`);
        try {
          fs.mkdirSync(path.dirname(out), { recursive: true });
          const argsList = ['-size', `${n}x${n}`, 'xc:white', '-fill', color, '-stroke', 'black'];
          if (shape === 'text') {
            const label = String(args.text ?? '').trim() || 'Jarv';
            argsList.push('-draw', `gravity center text 0,0 "${label.replace(/"/g, '')}"`);
          } else {
            argsList.push('-draw', shapeScript(shape, n, color));
          }
          argsList.push(out);
          await execFileAsync('magick', argsList);
          if (!fs.existsSync(out)) return { ok: false, error: 'image was not created' };
          const app = String(args.app ?? '').trim() || 'Preview';
          await execFileAsync('open', ['-a', app, out]);
          pruneOldDrawings();
          return { ok: true, shape, size: n, savedTo: out, openedIn: app };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
