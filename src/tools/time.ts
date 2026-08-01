import type { ToolDefinition } from '../agent/types.js';

export function timeTools(): ToolDefinition[] {
  return [
    {
      name: 'get_datetime',
      description:
        "Get the current date, time, timezone, and weekday. Use this whenever the user references 'now', 'today', 'tomorrow', 'this morning', etc.",
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const now = new Date();
        return {
          iso: now.toISOString(),
          local: now.toString(),
          date: now.toISOString().slice(0, 10),
          time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          unix: now.getTime(),
        };
      },
    },
  ];
}
