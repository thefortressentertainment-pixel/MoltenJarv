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
        "Correct a remembered fact by its id. GRAPH-style temporal update: the old fact is retained as HISTORY (its validity window is closed), and a new currently-valid fact is created with the corrected text — so nothing is lost and recall reflects the latest truth while the past stays queryable. Use when the user corrects a detail they previously told you. Returns the new fact id.",
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
      name: 'memory_history',
      system: 'memory',
      description:
        'Compare what is currently TRUE about a subject vs what used to be true (GRAPH temporal memory). Optionally pass a subject (e.g. "user") to see that entity\'s facts and their validity windows. Use when something may have changed over time — what the user prefers NOW vs before, or a fact that was superseded.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Optional entity (subject or object) to scope to, e.g. "user" or "coffee".' },
        },
      },
      handler: async (args, ctx) => {
        const subject = args.subject ? String(args.subject).trim().toLowerCase() : undefined;
        const store = (ctx.memory as unknown as { factStore: import('../memory/store.js').FactStore }).factStore;
        if (!store) throw new Error('memory store unavailable');
        const current = subject ? (await store.factsForSubject(subject)).filter((f) => !f.validTo || Date.parse(f.validTo) > Date.now()) : await store.validFacts();
        const history = subject ? (await store.factsForSubject(subject)).filter((f) => f.validTo && Date.parse(f.validTo) <= Date.now()) : await store.historicalFacts();
        return {
          subject,
          current: current.map((f) => ({ id: f.id, text: f.text, from: f.validFrom, relationship: f.relationship, object: f.object })),
          history: history.map((f) => ({ id: f.id, text: f.text, from: f.validFrom, until: f.validTo })),
          note: current.length === 0 && history.length === 0 ? 'no facts found' : undefined,
        };
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
