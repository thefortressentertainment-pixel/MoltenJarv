import fs from 'node:fs';
import type { ToolDefinition } from '../agent/types.js';

/**
 * Local vision via the Ollama HTTP API. Runs a small vision model (llava,
 * moondream, …) against an image file on disk so Jarv can identify
 * images/screenshots from any channel (Telegram, CLI, etc.) without a cloud
 * vision API key. Everything is on-device — no external network calls.
 */

const OLLAMA_BASE = 'http://127.0.0.1:11434';

async function ollamaIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function modelInstalled(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).some((m) => m.name.split(':')[0] === model);
  } catch {
    return false;
  }
}

export function visionTools(): ToolDefinition[] {
  return [
    {
      name: 'vision_identify',
      system: 'sense',
      description:
        'Identify and describe the contents of an image or screenshot file on disk using a on-device vision model (Ollama moondream, default — fast and light; pass model=\"llava\" for richer descriptive detail). Use when the user shares/attaches an image, a screenshot, a photo, or an image file path and wants to know what is in it. Runs fully on-device via the local Ollama API — no network calls, no cloud key.',
      inputSchema: {
        type: 'object',
        properties: {
          imagePath: {
            type: 'string',
            description: 'Absolute path to the image file to inspect (png, jpg, jpeg, gif, webp).',
          },
          question: {
            type: 'string',
            description: 'Optional specific question about the image. Defaults to a general "what is in this image".',
          },
          model: {
            type: 'string',
            description: "Ollama vision model name. Defaults to moondream (fast, light). Pass 'llava' for richer, more detailed descriptions.",
          },
        },
        required: ['imagePath'],
      },
      handler: async (args) => {
        const imagePath = String(args.imagePath ?? '').trim();
        if (!imagePath) return { ok: false, error: 'imagePath is required' };
        const model = String(args.model ?? 'moondream').trim() || 'moondream';
        const question = String(args.question ?? '').trim() || 'What is in this image? Identify and describe what it shows.';

        if (!(await ollamaIsUp())) {
          return {
            ok: false,
            error:
              'Ollama is not reachable at 127.0.0.1:11434. Start it with `ollama serve` and pull a vision model with `ollama pull llava`.',
          };
        }
        if (!(await modelInstalled(model))) {
          return {
            ok: false,
            error: `Vision model "${model}" is not installed. Pull it with: ollama pull ${model}`,
          };
        }

        let b64: string;
        try {
          b64 = fs.readFileSync(imagePath).toString('base64');
        } catch (err) {
          return { ok: false, error: `Cannot read image at ${imagePath}: ${err instanceof Error ? err.message : String(err)}` };
        }

        try {
          const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              stream: false,
              messages: [{ role: 'user', content: question, images: [b64] }],
            }),
            signal: AbortSignal.timeout(180_000),
          });
          if (!res.ok) {
            const text = await res.text();
            return { ok: false, error: `Ollama returned ${res.status}: ${text.slice(0, 300)}` };
          }
          const data = (await res.json()) as { message?: { content?: string }; error?: string };
          if (data.error) return { ok: false, error: data.error };
          const description = (data.message?.content ?? '').trim();
          if (!description) return { ok: false, error: 'Ollama returned an empty description.' };
          return { ok: true, model, imagePath, description };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
