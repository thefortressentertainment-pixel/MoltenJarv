import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolContext } from '../agent/types.js';
import type { JarvGenieConfig } from '../config/index.js';
import { resolveApiKey } from '../config/index.js';
import { dataHome } from '../config/defaults.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ComputerConfig {
  /** Allow control actions (AppleScript/System Events) — requires Accessibility permission. */
  allowControl?: boolean;
  /** Vision model used to describe screens. Default: primary endpoint with llama3.2-vision. */
  visionModel?: string;
  /** Vision endpoint (OpenAI-compatible). Default: the primary endpoint. */
  visionEndpoint?: string;
  /** Secret-store key for the vision API. Default: the primary provider's key. */
  visionApiKeyEnv?: string;
  /** Vision model used for camera captures. Default: visionModel. */
  cameraModel?: string;
  /** Vision endpoint used for camera captures. Default: visionEndpoint. */
  cameraEndpoint?: string;
  /** Secret-store key for camera captures. Default: visionApiKeyEnv. */
  cameraApiKeyEnv?: string;
}

export function computerStatus(config?: JarvGenieConfig): { implemented: boolean; note: string } {
  return {
    implemented: process.platform === 'darwin',
    note: process.platform === 'darwin'
      ? 'screenshot awareness on; control requires computer.allowControl'
      : 'computer tools are macOS-only on the hub machine',
  };
}

/** Capture the current screen to a PNG. macOS screen-recording permission needed. */
export async function screenshot(file: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('screenshot requires macOS');
  await execFileAsync('screencapture', ['-x', file]);
}

// On-device screen-text reading. macOS ships a Vision-framework OCR binary (no
// model download, ~no RAM), compiled once from scripts/screen_ocr.swift into
// ~/.jarv-genie/bin. This is the zero-footprint way for Jarv to "read" a
// webpage or screen on a small machine.
const OCR_BIN = path.join(dataHome(), 'bin', 'screen_ocr');
const OCR_SRC = path.join(__dirname, '..', '..', 'scripts', 'screen_ocr.swift');

async function ensureOcrBinary(): Promise<string | null> {
  if (existsSync(OCR_BIN)) return OCR_BIN;
  try {
    await fs.mkdir(path.dirname(OCR_BIN), { recursive: true });
    await execFileAsync('swiftc', ['-O', OCR_SRC, '-o', OCR_BIN], { timeout: 120_000 });
    return OCR_BIN;
  } catch {
    return null;
  }
}

/** Read the text visible in an image via macOS Vision OCR. Pure on-device. */
export async function extractScreenText(file: string): Promise<{ ok: boolean; text: string; error?: string }> {
  const bin = await ensureOcrBinary();
  try {
    const res = bin
      ? await execFileAsync(bin, [file], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
      : await execFileAsync('swift', [OCR_SRC, file], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const text = res.stdout.trim();
    return { ok: text.length > 0, text };
  } catch (err) {
    return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Describe what is on the screen using a vision-capable model. */
export async function describeScreen(file: string, config: JarvGenieConfig, question?: string): Promise<string> {
  const comp = (config as unknown as { computer?: ComputerConfig }).computer ?? {};
  return describeImage(file, config, {
    question,
    model: comp.visionModel,
    endpoint: comp.visionEndpoint,
    defaultPrompt: 'Describe what is visible on this screen, concisely. Mention any windows and their titles.',
  });
}

export interface DescribeImageOptions {
  question?: string;
  /** Model override (default: configured vision/camera model). */
  model?: string;
  /** Endpoint override (default: configured vision/camera endpoint). */
  endpoint?: string;
  /** Secret-store key name for the API (default: visionApiKeyEnv, else primary key). */
  apiKeyEnv?: string;
  /** Prompt used when no question is given. */
  defaultPrompt?: string;
}

/** Describe any image (screen grab or camera frame) using a vision-capable model. */
export async function describeImage(file: string, config: JarvGenieConfig, opts: DescribeImageOptions = {}): Promise<string> {
  const primary = config.providers.primary;
  const comp = (config as unknown as { computer?: ComputerConfig }).computer ?? {};
  const baseUrl = opts.endpoint ?? primary.baseUrl ?? 'http://127.0.0.1:11434/v1';
  const model = opts.model ?? 'llama3.2-vision';
  // The vision provider usually has its own key (e.g. Groq), so resolve it from
  // computer.visionApiKeyEnv before falling back to the primary provider's key.
  const keyEnv = opts.apiKeyEnv ?? comp.visionApiKeyEnv ?? (baseUrl.includes('groq') ? 'GROQ_API_KEY' : undefined);
  const key = (keyEnv ? resolveApiKey({ apiKeyEnv: keyEnv, model }) : resolveApiKey(primary)) ?? 'not-set';
  const b64 = await fs.readFile(file).then((b) => b.toString('base64'));

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: opts.question ?? opts.defaultPrompt ?? 'Describe this image concisely.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }>; error?: { message?: string } };
  if (!res.ok) throw new Error(data.error?.message ?? `vision request failed: HTTP ${res.status}`);
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Capture a still from the built-in (or first available) camera to a JPG.
 * Uses `imagesnap` when installed, else `ffmpeg` (avfoundation). Requires
 * macOS camera permission for the responsible app.
 */
export async function captureCamera(file: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('camera capture requires macOS');
  const ext = file.toLowerCase().endsWith('.jpg') || file.toLowerCase().endsWith('.jpeg') ? file : file + '.jpg';

  if (await hasCommand('imagesnap')) {
    try {
      // -w 1 gives the sensor a moment to expose; -q silences output.
      await execFileAsync('imagesnap', ['-q', '-w', '1', ext]);
      return;
    } catch (err) {
      const e = err as { stderr?: string };
      if (e.stderr && /No cameras|no camera/i.test(e.stderr)) {
        throw new Error('no camera found by imagesnap');
      }
      // fall through to ffmpeg on other failures
    }
  }

  if (await hasCommand('ffmpeg')) {
    const device = await pickCameraDevice();
    if (!device) throw new Error('no FaceTime/camera device found by ffmpeg');
    await execFileAsync('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'avfoundation',
      '-video_size', '1280x720',
      '-framerate', '1',
      '-i', device,
      '-frames:v', '1',
      '-y',
      ext,
    ]);
    return;
  }

  throw new Error(
    'no camera capture tool installed — run `brew install imagesnap` (or install ffmpeg) and grant camera permission, then try again',
  );
}

async function pickCameraDevice(): Promise<string | null> {
  try {
    const res = await execFileAsync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeout: 10_000 });
    const names = res.stderr ?? '';
    const candidates = names
      .split('\n')
      .filter((l) => /\[AVFoundation\]/.test(l) && /(FaceTime|Camera|Webcam)/i.test(l))
      .map((l) => (l.match(/\[(\d+)\]/)?.[1] ?? ''));
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

export async function openApp(app: string): Promise<void> {
  // Tests set JARV_GENIE_NO_OPEN=1 so the suite never opens real apps.
  if (process.env.JARV_GENIE_NO_OPEN === '1') return;
  await execFileAsync('open', ['-a', app]);
}

/** Run an AppleScript. Requires computer.allowControl and macOS Accessibility permission. */
export async function runAppleScript(script: string): Promise<string> {
  const res = await execFileAsync('osascript', ['-e', script]);
  return res.stdout;
}

export function controlAllowed(config: JarvGenieConfig): boolean {
  return (config as unknown as { computer?: ComputerConfig }).computer?.allowControl === true;
}
