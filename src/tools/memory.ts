import type { ToolDefinition } from '../agent/types.js';

export function memoryTools(): ToolDefinition[] {
  return [
    {
      name: 'remember',
      system: 'memory',
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
      system: 'memory',
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
      system: 'memory',
      description: 'List all facts currently remembered by the agent.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => ctx.memory.listFacts(),
    },
    {
      name: 'delete_fact',
      system: 'memory',
      description: 'Delete a remembered fact by its id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The fact id, as returned by list_facts or recall.' } },
        required: ['id'],
      },
      handler: async (args, ctx) => ctx.memory.deleteFact(String(args.id ?? '')),
    },
    {
      name: 'memory_update',
      system: 'memory',
      description:
        "Correct a remembered fact in place (update-don't-duplicate) by its id, so a wrong or stale fact is replaced rather than piling up next to a duplicate. Use when the user corrects a detail they previously told you. Returns the updated fact id.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The fact id to update (from list_facts or recall).' },
          text: { type: 'string', description: 'The corrected fact text.' },
        },
        required: ['id', 'text'],
      },
      handler: async (args, ctx) => {
        const id = String(args.id ?? '').trim();
        const text = String(args.text ?? '').trim();
        if (!id || !text) throw new Error('memory_update requires id and text');
        const result = await ctx.memory.updateFact(id, text);
        if (!result) throw new Error(`no fact with id "${id}" — run list_facts to see ids`);
        return result;
      },
    },
    {
      name: 'memory_read',
      system: 'memory',
      description:
        'Read one remembered fact in full by its id. Use when recall returned only a summary or you need the exact wording of a stored fact.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The fact id to read.' } },
        required: ['id'],
      },
      handler: async (args, ctx) => {
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('memory_read requires id');
        const fact = (await ctx.memory.listFacts()).find((f) => f.id === id);
        if (!fact) throw new Error(`no fact with id "${id}"`);
        return { id: fact.id, text: fact.text, createdAt: fact.createdAt };
      },
    },
  ];
}
