/**
 * Computer use / device reach — planned for v3 (see docs/ROADMAP.md).
 *
 * Target: a daemon on each device (laptop, phone, desktop) connecting back to
 * one hub over an authenticated channel, with screen awareness and scoped
 * input control (accessibility APIs, per-app approval, audit trail).
 *
 * This module currently declares the contract only; no automation code ships
 * yet.
 */
export interface DeviceSidecar {
  id: string;
  connect(): Promise<void>;
  screenshot(): Promise<unknown>;
  executeScopedAction(action: unknown): Promise<unknown>;
}

export const computerStatus = {
  implemented: false,
  planned: 'always-on hub daemon + per-device sidecars; screen awareness and scoped input control',
} as const;
