import type { ToolDefinition } from '../agent/types.js';
import { systemStatus, statusSummary } from '../computer/status.js';

export function statusTools(): ToolDefinition[] {
  return [
    {
      name: 'system_status',
      description:
        'Get the current state of the machine: power source and battery %, CPU load, memory and disk usage, uptime, network IPs and Wi-Fi. Read-only. Use whenever the user asks about the machine, or to decide whether an action is safe (battery, disk space, network).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const s = await systemStatus();
        return { ok: true, summary: statusSummary(s), status: s };
      },
    },
  ];
}
