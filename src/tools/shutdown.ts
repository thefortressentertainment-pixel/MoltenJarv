import type { ToolDefinition } from '../agent/types.js';
import { powerDown, readShutdownLog, verifyLastShutdown } from '../cli/shutdown.js';

/**
 * Power-down tools: Jarv can shut the Mac down on the owner's command, and can
 * read the shutdown log + verify against boot time so it only claims a shutdown
 * happened when it can actually prove it.
 */

export function shutdownTools(): ToolDefinition[] {
  return [
    {
      name: 'shutdown_mac',
      description:
        'Power down the Mac completely. The most consequential action — only use when the owner explicitly asks Jarv to shut the machine down. Logs the request first so the next boot can verify it happened.',
      inputSchema: { type: 'object', properties: {} },
      consequential: true,
      handler: async () => powerDown('telegram'),
    },
    {
      name: 'shutdown_status',
      description:
        'Check the shutdown log and verify whether the last requested shutdown actually powered the Mac off (by comparing the request time to the current boot time). Use this to confirm, never assume.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        log: readShutdownLog(),
        verification: await verifyLastShutdown(),
      }),
    },
  ];
}
