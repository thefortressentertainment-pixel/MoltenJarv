import type { ToolDefinition } from '../agent/types.js';

export function memoryTools(): ToolDefinition[] {
  return [
    {
      name: 'remember',
      description:
        'Store a durable fact about the user or their world (preferences, names, appointments, decisions). The fact is remembered across sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact to remember.' },
          source: { type: 'string', description: 'Optional provenance, e.g. "conversation" or "user".' },
        },
        required: ['text'],
      },
      handler: async (args, ctx) => {
        const text = String(args.text ?? '').trim();
        if (!text) throw new Error('remember requires a non-empty text');
        const source = args.source ? String(args.source) : 'user';
        return ctx.memory.addFact(text, source);
      },
    },
    {
      name: 'recall',
      description:
        'Search remembered facts semantically. Use when the user references something from their past, preferences, or prior conversations.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The thing to look for, in natural language.' },
          k: { type: 'number', description: 'Max results (default 5).' },
        },
        required: ['query'],
      },
      handler: async (args, ctx) => {
        const query = String(args.query ?? '');
        if (!query.trim()) throw new Error('recall requires a query');
        const k = typeof args.k === 'number' ? Math.max(1, Math.min(20, Math.floor(args.k))) : 5;
        return ctx.memory.recall(query, { k });
      },
    },
    {
      name: 'list_facts',
      description: 'List all facts currently remembered by the agent.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => ctx.memory.listFacts(),
    },
    {
      name: 'delete_fact',
      description: 'Delete a remembered fact by its id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The fact id, as returned by list_facts or recall.' } },
        required: ['id'],
      },
      handler: async (args, ctx) => ctx.memory.deleteFact(String(args.id ?? '')),
    },
  ];
}
