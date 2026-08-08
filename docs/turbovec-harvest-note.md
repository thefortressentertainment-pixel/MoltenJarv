# Turbovec — Harvest Assessment

Reference: `RyanCodrai/turbovec` (MIT, 14.7k★) — a Rust vector index built on
Google's TurboQuant (data-oblivious, no-train quantization; ICLR 2026). Headline:
"10M documents take 31 GB as float32; turbovec fits them in 4 GB, searched faster
than FAISS."

> Note: the profile `github.com/turbovec` (Daniel Barron) is an empty account
> with no public repos — the live project is `RyanCodrai/turbovec`, which is what
> this assessment covers.

## Goal under evaluation

"Shrink the size of Jarv without compromising functionality" (so it stays
responsive alongside Blender/Unreal on an 8 GB M1).

## Verdict: not a fit at Jarv's current scale (adopt only later)

Turbovec quantizes **vector embeddings** — its win comes at *million-document*
corpora. Jarv's entire embedding footprint today is tiny:

| Store | Vectors | Dim | Full FP32 bytes | Turbovec 2-bit | Max saving |
|---|---|---|---|---|---|
| Facts (`facts.vectors.json`) | 12 | 768 | 36 KB | 2.3 KB | ~34 KB |
| RAG (`rag/index.json`) | 18 | 768 | 54 KB | ~7 KB | ~47 KB |
| **Total** | **30** | 768 | **~90 KB** | ~10 KB | **~80 KB** |

- The whole vector corpus is **~90 KB**. Quantizing it saves at most **~80 KB of
  RAM** — far less than the memory a Rust subprocess / Python binding would add
  just to be loaded.
- Jarv's **real RAM** lives in its Node daemons (~90–114 MB each) and the Ollama
  model, not embeddings. The correct lever for the stated goal is the **model
  (see the 0.5B sizing discussion)** and process footprint, not vector
  compression.
- Adopting turbovec now would add a heavy dependency for a ~KB-scale saving —
  a net RAM *loss* and a complexity cost with zero functional gain.

## What IS transferable (for later, per the structure-for-later framing)

1. **Length-renormalized quantization pattern** — strip per-vector norm, rotate,
   calibrate, Lloyd-Max quantize, store a per-vector renormalization scalar. If
   Jarv's RAG ever grows to tens/hundreds of thousands of chunks (e.g. after
   indexing a real Documents corpus with MinerU at T3), porting *this schema*
   (not the Rust runtime) into the existing JSON `SemanticSearch` would shrink
   the index ~16x while keeping recall. **Trigger: ≥ a few hundred MB of vectors.**
2. **Search-time allowlist filtering** — `search(query, k, allowlist)` inside the
   kernel. Jarv's recall could apply an external candidate set (e.g. BM25 or a
   root/subject filter) before vector scoring. This is a *search-contract* idea
   worth adopting now independent of quantization — see the note below, though the
   existing `index` is too small for it to matter yet.
3. **TurboQuant-specific (no-derivatives caution)**: the algorithm is ARXIV/ICLR
   paper-based; the MIT code is a reference. Reimplementing the Math from the
   paper is fine; do not vendor the Rust/Python crate for a KB-scale store.

## Decision

**Do not integrate turbovec now.** It does not shrink Jarv meaningfully and would
cost more RAM than it saves. Logged here so that when Jarv's embedding corpus
grows big enough (≳ a few hundred MB of vectors, likely at T3 after MinerU doc
ingestion), the quantization path — via the `index`/recall allowlist filter and a
TS port of the renormalized quantizer — is a known, ready upgrade rather than a
re-discovery.
