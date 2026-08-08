import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Personal-knowledge RAG (JARVIS blueprint §C5 / P5, LlamaIndex pattern; MIT),
 * kept deliberately lean for an 8 GB Mac: a local, single-directory content
 * index that turns the user's own markdown/text/source files into a queryable
 * knowledge base using the already-configured local embeddings endpoint
 * (e.g. Ollama nomic-embed-text). No second database; the index is a single
 * JSON file persisted to `~/.jarv-genie/rag/index.json`.
 *
 * Pipeline (mirrors SimpleDirectoryReader → vector index → query_engine):
 *   index ← read files → split into chunks → embed+persist chunks.
 *   query  ← embed the query → cosine rank (fallback lexical) → top-k chunks.
 *
 * The embedder is injectable so the RAG math is unit-testable without an
 * endpoint. When embeddings are unavailable, query still works via keyword/Jaccard.
 */

export interface RagChunk {
  /** Stable id: `<fileHash>:<index>`. */
  id: string;
  /** Absolute source path. */
  path: string;
  /** File basename for display. */
  file: string;
  /** Chunk text. */
  text: string;
  /** Chunk ordinal within its file. */
  index: number;
  /** Embedded vector (optional, kept in the persisted index). */
  vector?: number[];
}

export interface RagIndex {
  chunks: RagChunk[];
  /** Epoch ms when the index was built. */
  builtAt: number;
  /** Root dir that was indexed. */
  root: string;
}

/** File extensions/names we index (plain-text-readable, no heavy doc parsing on
 *  an 8 GB machine). PDFs/DOCX are out of scope for the T1 RAG. */
const INDEXABLE = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.log', '.csv', '.ts', '.js', '.tsx', '.jsx', '.py', '.yaml', '.yml', '.toml', '.sh', '.html']);

/** Split text into chunks of ~chunkChars with chunkOverlap, on word boundaries. */
export function chunkText(text: string, chunkChars = 1500, overlap = 200): string[] {
  // Normalise whitespace runs, preserve paragraphs.
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const tokens = clean.split(/\s+/);
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const tok of tokens) {
    cur.push(tok);
    curLen += tok.length + 1;
    if (curLen >= chunkChars) {
      chunks.push(cur.join(' '));
      // Carry the last chunkOverlap chars' tokens into the next chunk.
      const overlapWords: string[] = [];
      let ovLen = 0;
      for (const t of [...cur].reverse()) {
        if (ovLen >= overlap) break;
        overlapWords.unshift(t);
        ovLen += t.length + 1;
      }
      cur = overlapWords;
      curLen = ovLen;
    }
  }
  if (cur.length > 0) chunks.push(cur.join(' '));
  return chunks.filter((c) => c.trim().length > 0);
}

/** A stable 8-char hash for a string (path or mtime). */
export function stableHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(8, '0');
}

/** Scan a directory (recursive, with depth/size guards) for indexable files,
 *  returning {file, mtimeMs}. */
export async function discoverFiles(
  dir: string,
  opts: { maxFiles?: number; skip?: string[] } = {},
): Promise<Array<{ file: string; mtimeMs: number }>> {
  const maxFiles = opts.maxFiles ?? 400;
  const skip = new Set((opts.skip ?? []).concat(['node_modules', '.git', '.DS_Store', 'Library', '.cache', 'Library/Application Support']));
  const out: Array<{ file: string; mtimeMs: number }> = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) {
          if (depth < 6) await walk(full, depth + 1);
        } else if (e.isFile() && INDEXABLE.has(path.extname(e.name).toLowerCase())) {
          const st = await fs.stat(full);
          out.push({ file: full, mtimeMs: st.mtimeMs });
        }
      } catch {
        // unreadable entry → skip
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/** Read a text file and return its content (guards binary/oversize). */
async function readText(file: string, maxBytes = 512 * 1024): Promise<string> {
  const st = await fs.stat(file);
  if (st.size > maxBytes) return '';
  const buf = await fs.readFile(file);
  return buf.toString('utf8');
}

export async function loadIndex(file: string): Promise<RagIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as RagIndex;
    if (parsed && Array.isArray(parsed.chunks)) return parsed;
    return { chunks: [], builtAt: 0, root: '' };
  } catch {
    return { chunks: [], builtAt: 0, root: '' };
  }
}

export interface BuildResult {
  indexedFiles: number;
  chunks: number;
  newChunks: number;
  skippedChanged: number;
}

/**
 * (Re)build the RAG index for `root`. Only new/changed files are embedded;
 * unchanged chunk ids are reused (their vectors stay valid). Fail-open: unreadable
 * files and embed errors are skipped, the index is written as best as it got.
 */
export async function buildIndex(
  root: string,
  indexFile: string,
  embed: (texts: string[]) => Promise<number[][]>,
  opts: { maxFiles?: number; chunkChars?: number; overlap?: number } = {},
): Promise<BuildResult> {
  const prev = await loadIndex(indexFile);
  const files = await discoverFiles(root, { maxFiles: opts.maxFiles ?? 400 });
  const chunks: RagChunk[] = [];
  let newChunks = 0;
  let indexedFiles = 0;

  for (const f of files) {
    const fid = `${stableHash(f.file)}:${stableHash(String(f.mtimeMs))}`;
    // Reuse unchanged chunk ids (vectors stay valid) when a prior build keyed
    // the same file at the same mtime.
    const reusable = prev.chunks.filter((c) => c.id.startsWith(`${fid}`));
    if (reusable.length > 0) {
      chunks.push(...reusable);
      indexedFiles++;
      continue;
    }
    let text = '';
    try {
      text = await readText(f.file);
    } catch {
      continue;
    }
    const textChunks = chunkText(text, opts.chunkChars ?? 1500, opts.overlap ?? 200);
    if (textChunks.length === 0) continue;
    let vectors: number[][] = [];
    try {
      vectors = await embed(textChunks);
    } catch {
      vectors = textChunks.map(() => []);
    }
    for (let i = 0; i < textChunks.length; i++) {
      chunks.push({ id: `${fid}:${i}`, path: f.file, file: path.basename(f.file), index: i, text: textChunks[i]!, vector: vectors[i] });
    }
    newChunks += textChunks.length;
    indexedFiles++;
  }

  // Keep only chunks whose file was still discovered (drop removed files).
  const validPaths = new Set(files.map((f) => f.file));
  const finalChunks = chunks.filter((c) => validPaths.has(c.path));
  const builtAt = Date.now();
  const index: RagIndex = { chunks: finalChunks, builtAt, root };
  await fs.mkdir(path.dirname(indexFile), { recursive: true });
  await fs.writeFile(indexFile, JSON.stringify(index, null, 2) + '\n');
  return { indexedFiles, chunks: finalChunks.length, newChunks, skippedChanged: Math.max(0, files.length - indexedFiles) };
}

export interface RagHit {
  path: string;
  file: string;
  text: string;
  score: number;
}

/** Cosine similarity, reused from the memory search math (no embeddings → 0). */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Lexical Jaccard overlap (fallback when no vectors). */
export function jaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
  const tb = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Query the index. Uses vector cosine when chunks have vectors (and an embedder
 * is injected), else lexical Jaccard. Returns top-k hits with a clamped [0,1]
 * score each.
 */
export async function queryIndex(
  index: RagIndex,
  query: string,
  embed: (texts: string[]) => Promise<number[][]>,
  k = 5,
): Promise<RagHit[]> {
  let queryVec: number[] | undefined;
  try {
    if (index.chunks.some((c) => c.vector && c.vector.length > 0)) {
      [queryVec] = await embed([query]);
    }
  } catch {
    queryVec = undefined;
  }
  const scored: RagHit[] = [];
  for (const c of index.chunks) {
    let score: number;
    if (queryVec && c.vector && c.vector.length === queryVec.length) {
      score = cosine(queryVec, c.vector);
    } else {
      score = jaccard(c.text, query);
    }
    if (score > 0) scored.push({ path: c.path, file: c.file, text: c.text.slice(0, 2000), score: clamp(score) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(1, k));
}

function clamp(x: number): number {
  return Math.max(0, Math.min(1, x));
}
