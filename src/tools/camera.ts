import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext, ToolDefinition } from '../agent/types.js';
import type { JarvGenieConfig } from '../config/index.js';
import { captureCamera, describeImage, type ComputerConfig } from '../computer/index.js';

export function cameraTools(): ToolDefinition[] {
  return [
    {
      name: 'camera_capture',
      description:
        'Capture a still photo from the built-in camera on the hub machine and describe what (and who) is in view. Requires macOS camera permission and `imagesnap` (brew install imagesnap) or ffmpeg. Optionally pass a question about what you want to check.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Optional specific question about what is in view (e.g. "is anyone here?")' },
        },
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-cam-'));
        try {
          const file = path.join(dir, 'cam.jpg');
          await captureCamera(file);
          const comp = (ctx.config as JarvGenieConfig as unknown as { computer?: ComputerConfig }).computer ?? {};
          const question = String(args.question ?? '').trim() || undefined;
          const description = await describeImage(file, ctx.config as JarvGenieConfig, {
            question,
            model: comp.cameraModel ?? comp.visionModel,
            endpoint: comp.cameraEndpoint ?? comp.visionEndpoint,
            defaultPrompt: 'Describe what is visible in this camera photo, concisely. Mention people, their activity, and the room.',
          });
          return { ok: true, description };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    },
  ];
}
