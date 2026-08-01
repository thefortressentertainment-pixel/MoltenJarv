import { execFile } from 'node:child_process';
import os from 'node:os';
import type { RemoteClient } from '../remote/client.js';
import { speak as ttsSpeak } from '../voice/index.js';

export interface SidecarOptions {
  name?: string;
  /** Deliver events by speaking them aloud. */
  speak?: boolean;
  /** Deliver events as macOS notifications. Default true on darwin. */
  notify?: boolean;
}

export function notify(text: string): void {
  if (process.platform !== 'darwin') return;
  const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 400);
  execFile('osascript', ['-e', `display notification "${safe}" with title "Jarv Genie"`], () => {
    // best effort
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Device sidecar: registers this machine with the hub and long-polls for pushed
 * events (notifications / speech), delivering them locally. This is the
 * multi-channel delivery arm — run one on any device that should hear Jarv Genie.
 */
export async function runSidecar(client: RemoteClient, opts: SidecarOptions = {}): Promise<void> {
  const name = opts.name ?? os.hostname();
  const speak = opts.speak ?? false;
  const notifyOn = opts.notify ?? true;
  const capabilities: string[] = [];
  if (speak) capabilities.push('speak');
  if (notifyOn && process.platform === 'darwin') capabilities.push('notify');

  process.stdout.write(
    `[jarv-genie] sidecar "${name}" → ${client.baseUrl} (ctrl-c to stop)\n` +
      `  capabilities: ${capabilities.join(', ') || 'stdout only'}\n`,
  );

  let registered = false;
  for (;;) {
    try {
      const { device } = await client.register({ name, platform: `${os.platform()} ${os.release()}`, capabilities });
      if (!registered) {
        registered = true;
        process.stdout.write(`  registered as ${device.id}\n`);
      }
      const { event } = await client.waitEvent(device.id, 25);
      if (!event) continue;
      const stamp = new Date().toISOString();
      process.stdout.write(`[${stamp}] ${event.kind}: ${event.text}\n`);
      if (event.kind === 'say' || speak) {
        await ttsSpeak(event.text);
      } else if (notifyOn) {
        notify(event.text);
      }
    } catch (err) {
      registered = false;
      process.stdout.write(`\n  hub unreachable: ${err instanceof Error ? err.message : String(err)} — retrying in 5s\n`);
      await sleep(5000);
    }
  }
}

/** Push a message to device sidecar(s) through the hub. */
export async function sendNotify(client: RemoteClient, text: string, opts: { device?: string; speak?: boolean } = {}): Promise<void> {
  const res = await client.notify({ text, device: opts.device, speak: opts.speak });
  if (res.enqueued === 0) {
    process.stdout.write('no devices are connected — run `jarv-genie sidecar` on the target device\n');
  } else {
    process.stdout.write(`queued for ${res.enqueued} device${res.enqueued === 1 ? '' : 's'}\n`);
  }
}
