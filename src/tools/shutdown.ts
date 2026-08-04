import type { ToolDefinition } from '../agent/types.js';
import { powerDown, readShutdownLog } from '../cli/shutdown.js';

/**
 * Power-down tools: Jarv can shut the Mac down on the owner's command, and can
 * read the shutdown log to confirm past shutdowns actually happened.
 */

export function shutdownTools(): ToolDefinition[] {
  return [
    {
      name: 'shutdown_mac',
      description:
        'Power down the Mac completely. The most consequential action — only use when the owner explicitly asks Jarv to shut the machine down. Logs the request first so the next boot can confirm it happened.',
      inputSchema: { type: 'object', properties: {} },
      consequential: true,
      handler: async () => powerDown('telegram'),
    },
    {
      name: 'shutdown_status',
      description: 'Read the shutdown log: when Jarv was asked to shut the Mac down, and whether it powered off.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ log: readShutdownLog() }),
    },
  ];
}
