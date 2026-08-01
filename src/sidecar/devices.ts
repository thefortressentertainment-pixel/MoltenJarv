import fs from 'node:fs';
import path from 'node:path';
import { dataHome } from '../config/defaults.js';

export interface Device {
  id: string;
  name: string;
  platform: string;
  capabilities: string[];
  lastSeen: number;
}

export interface PushEvent {
  id: string;
  device: string;
  kind: 'notify' | 'say';
  text: string;
  ts: number;
}

/**
 * Registry of connected devices plus a per-device push queue. The hub owns one
 * of these; device sidecars long-poll `GET /api/devices/:id/events` to receive
 * notifications and speech. Persisted under ~/.jarv-genie so deliveries survive
 * hub restarts until a device picks them up.
 */
export class DeviceStore {
  private devices: Device[] = [];
  private pending: PushEvent[] = [];
  private waiters = new Map<string, Array<() => void>>();

  constructor(private dir: string = dataHome()) {
    this.load();
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file('devices.json'), 'utf8'));
      this.devices = Array.isArray(raw.devices) ? (raw.devices as Device[]) : [];
    } catch {
      this.devices = [];
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file('events.json'), 'utf8'));
      this.pending = Array.isArray(raw.events) ? (raw.events as PushEvent[]) : [];
    } catch {
      this.pending = [];
    }
  }

  save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file('devices.json'), JSON.stringify({ devices: this.devices }, null, 2) + '\n');
    fs.writeFileSync(this.file('events.json'), JSON.stringify({ events: this.pending }, null, 2) + '\n');
  }

  list(): Device[] {
    return this.devices.map((d) => ({ ...d }));
  }

  /** Upsert a device by name; refreshes lastSeen. */
  register(name: string, platform: string, capabilities: string[] = []): Device {
    const existing = this.devices.find((d) => d.name === name);
    const device: Device = {
      id: existing?.id ?? `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      platform,
      capabilities,
      lastSeen: Date.now(),
    };
    const idx = this.devices.findIndex((d) => d.id === device.id);
    if (idx >= 0) this.devices[idx] = device;
    else this.devices.push(device);
    this.save();
    return { ...device };
  }

  enqueue(device: string, kind: PushEvent['kind'], text: string): PushEvent {
    const ev: PushEvent = { id: `ev-${Date.now().toString(36)}`, device, kind, text, ts: Date.now() };
    this.pending.push(ev);
    this.save();
    const ws = this.waiters.get(device);
    if (ws) {
      for (const w of ws) w();
      this.waiters.delete(device);
    }
    return ev;
  }

  dequeue(device: string): PushEvent | null {
    const idx = this.pending.findIndex((e) => e.device === device);
    if (idx < 0) return null;
    const [ev] = this.pending.splice(idx, 1);
    this.save();
    return ev ?? null;
  }

  /** Resolve when an event for `device` arrives, or after `timeoutMs`. */
  waitFor(device: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const arr = this.waiters.get(device) ?? [];
      const timer = setTimeout(() => {
        this.removeWaiter(device, onEvent);
        resolve();
      }, timeoutMs);
      const onEvent = () => {
        clearTimeout(timer);
        this.removeWaiter(device, onEvent);
        resolve();
      };
      arr.push(onEvent);
      this.waiters.set(device, arr);
    });
  }

  private removeWaiter(device: string, fn: () => void): void {
    const arr = this.waiters.get(device);
    if (!arr) return;
    const next = arr.filter((f) => f !== fn);
    if (next.length > 0) this.waiters.set(device, next);
    else this.waiters.delete(device);
  }
}

/** Enqueue a push to all devices (or one by name/id). Returns events queued. */
export function pushNotify(
  store: DeviceStore,
  text: string,
  opts: { device?: string; speak?: boolean } = {},
): PushEvent[] {
  const kind: PushEvent['kind'] = opts.speak ? 'say' : 'notify';
  const all = store.list();
  const targets = opts.device
    ? all.filter((d) => d.name === opts.device || d.id === opts.device)
    : all;
  return targets.map((d) => store.enqueue(d.id, kind, text));
}
