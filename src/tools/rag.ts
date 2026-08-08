import path from 'node:path';
import type { ToolDefinition, ToolContext } from '../agent/types.js';
import type { JarvGenieConfig } from '../config/index.js';
import { resolveEmbeddingsConfig } from '../config/index.js';
import { dataHome } from '../config/defaults.js';
import { EmbeddingClient } from '../memory/embeddings.js';
import { buildIndex, loadIndex, queryIndex } from '../rag.js';

/**
 * Personal-knowledge RAG tools (JARVIS blueprint §C5 / P5).
 * Lets Jarv index a directory of its own files (docs, notes, code) into a
 * local, embedding-backed knowledge base and query it semantically — the
 * "bring-your-own-corpus" memory J.A.R.V.I.S. has over Stark's data. Fully
 * local via the configured embeddings endpoint (Ollama nomic-embed-text).
 *
 * `rag_index` is consequential only in that it writes the index file; it reads
 * documents and never executes anything. Reads are non-consequential.
 */
export function ragTools(indexDir?: string): ToolDefinition[] {
  const dir = indexDir ?? path.join(dataHome(), 'rag');
  const indexFile = path.join(dir, 'index.json');

  function embeddings(cfg: JarvGenieConfig): (texts: string[]) => Promise<number[][]> {
    const ep = resolveEmbeddingsConfig(cfg);
    return ep ? (texts) => new EmbeddingClient(ep).embed(texts) : () => Promise.reject(new Error('no embeddings endpoint'));
  }

  return [
    {
      name: 'rag_index',
      system: 'memory',
      description:
        'Index a directory of personal knowledge (docs, notes, markdown, code, logs) into Jarv\'s local RAG store so it can be semantically queried with rag_query. Reads text files (md/txt/json/log/csv/source), chunks them, and embeds them locally. Use to give Jarv a queryable memory over your own files. Specify the absolute path to a directory (default ~/Documents). Only changed files are re-embedded on later runs.',
      inputSchema: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Absolute path to the directory to index. Default ~/Documents.' },
        },
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const root = String(args.dir ?? '').trim() || path.join(process.env.HOME ?? '/', 'Documents');
        const cfg = ctx.config as JarvGenieConfig;
        let res;
        try {
          res = await buildIndex(root, indexFile, embeddings(cfg), { maxFiles: 400 });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        return {
          ok: true,
          indexFile,
          root,
          indexedFiles: res.indexedFiles,
          chunks: res.chunks,
          newChunks: res.newChunks,
          skippedChanged: res.skippedChanged,
        };
      },
    },
    {
      name: 'rag_query',
      system: 'memory',
      description:
        'Semantically query Jarv\'s local knowledge base (built with rag_index) over your personal files — notes, docs, code, logs. Returns the top matching chunks with their source file paths and a relevance score. Use when the answer may live in the user\'s own documents or past notes rather than the live web or memorized facts.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The thing to look for, in natural language.' },
          k: { type: 'number', description: 'Max results (default 5).' },
        },
        required: ['query'],
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const query = String(args.query ?? '').trim();
        if (!query) return { ok: false, error: 'query is required' };
        const k = typeof args.k === 'number' ? Math.max(1, Math.min(20, Math.floor(args.k))) : 5;
        const cfg = ctx.config as JarvGenieConfig;
        const index = await loadIndex(indexFile);
        if (index.chunks.length === 0) {
          return {
            ok: true,
            empty: true,
            note: 'Knowledge base is empty — run rag_index first to index a directory.',
            results: [],
          };
        }
        let hits;
        try {
          hits = await queryIndex(index, query, embeddings(cfg), k);
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const results = hits.map((h) => ({ file: h.file, path: h.path, score: h.score, text: h.text }));
        return { ok: true, empty: false, indexRoot: index.root, results, top: results[0] ?? undefined };
      },
    },
    {
      name: 'rag_status',
      system: 'memory',
      description:
        'Show the state of Jarv\'s local knowledge base: how many chunks are indexed, from which root, and when it was last built.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args: Record<string, unknown>) => {
        const index = await loadIndex(indexFile);
        return {
          ok: true,
          root: index.root || '(not indexed yet)',
          chunks: index.chunks.length,
          builtAt: index.builtAt ? new Date(index.builtAt).toISOString() : undefined,
        };
      },
    },
  ];
}
