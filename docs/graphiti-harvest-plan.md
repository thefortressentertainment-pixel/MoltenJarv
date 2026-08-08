# Graphiti (GRAPH) — Harvest & Implementation Plan

Reference source: `getzep/graphiti` (Apache-2.0, 29.7k★) — a temporal context
graph engine ("Build Temporal Context Graphs for AI Agents"). Its thesis: agent
memory is not a flat list of facts but a **temporal graph** of entities,
relationships, and facts, each with a **validity window** (when it became true,
when superseded), **provenance** (traces to the raw episode that produced it),
and **incremental ingestion**. Nothing is copied — each item borrows a pattern
and re-expresses it in Jarv's TypeScript / existing JSON `FactStore`, in keeping
with Apache-2.0.

## The gap it fills

Jarv's memory (`src/memory/`, `FactStore`) is a flat, append-style list of
durable facts with update-don't-duplicate. Recall is semantic+BM25 over flat
fact text. Gaps vs J.A.R.V.I.S.-grade memory:

- **No "what's true NOW vs what WAS true"** — an update overwrites text, losing
  the past ("user preferred dark mode... until March" is gone).
- **No provenance** — a fact can't be traced to the utterance/task-run that
  produced it.
- **No entity structure** — facts are flat strings; you can't ask "what does the
  user relate to?" or traverse from an entity.
- **No history query** — superseded truths aren't retrievable.

GRAPH's core (from the README): *"facts have validity windows. When information
changes, old facts are invalidated — not deleted. Query what's true now, or what
was true at any point in time"* + *"everything traces back to episodes"* +
hybrid retrieval (semantic + keyword + graph traversal).

## What was harvested (T1, 8GB-safe, JSON store — no Neo4j/FalkorDB)

The heavy Graphiti infrastructure (Neo4j/FalkorDB/Neptune backends, Python SDK,
MCP server, telemetry, community/ontology Pydantic models) is **explicitly OUT**
— it needs a graph DB or a ≥T3 hub, not this 8 GB Mac. What transferred is the
*schema + storage semantics*, implemented in the existing `FactStore`.

### Done

1. **Temporal validity windows** (GRAPH §"Temporal Fact Management")
   - `MemoryFact` gained `validFrom?` / `validTo?` (`src/memory/types.ts`).
   - `FactStore.update` now **supersedes, never overwrites**: the old fact's
     `validTo` is set (retained as history) and a NEW currently-valid fact is
     created (`src/memory/store.ts`). Backward-compatible: all fields optional,
     existing 17-fact store loads untouched.
   - New queries `validFacts()` / `historicalFacts()` — "what's true now" vs
     "what was true".

2. **Episodes / provenance** (`src/memory/types.ts`): `provenance?` — the raw
   trace (utterance / source doc) each fact traces back to. The P4 `extract`
   loop stamps it from its input.

3. **Entity triplets** (`src/memory/triplet.ts`): a small, injectable,
   fail-open LLM extractor that turns a durable fact into
   `(subject → relationship → object)`, e.g. `(user, prefers, dark mode)`.
   `MemoryFact` carries `subject/relationship/object`. Stored via `addFactMeta`.

4. **Subject-scoped / traversal recall** (`FactStore.factsForSubject`) — recall
   can now walk from an entity, plus a `memory_history` tool that reports
   current-vs-superseded for a subject.

5. **Hybrid retrieval preserved**: Jarv's existing `SemanticSearch` (semantic +
   BM25 + MMR + temporal decay + access boost) is untouched; the new triplet/
   validity fields layer *structured* querying on top. (GRAPH's graph *traversal*
   is approximated by `factsForSubject`; full graph DB traversal is T3.)

6. **Incremental ingestion confirmed**: the P4 `extract` loop (already
   incremental) now stamps validity (`validFrom`), provenance, and triplets on
   every durable fact it writes.

### Tests

`test/memory-temporal.test.ts` (7 new) + `test/memory.test.ts` updated for the
supersede behavior. Full suite 368 passing, typecheck + build clean.

## Not ported (T2/T3)

- **Graph database backends** (Neo4j/FalkorDB/Neptune) + Python SDK — heavy;
  needs a graph DB. Jarv's JSON store keeps the *schema* without the infra.
- **Hybrid graph traversal at scale** — approximated now via `factsForSubject`;
  real multi-hop traversal when a graph backend lands on T3.
- **Custom-type ontology (Pydantic)** — Jarv's facts are open-text; a prescribed
  ontology is unnecessary for single-user memory.
- **MCP server / REST service / telemetry** — Jarv already self-serves.

## Status

All of the above **implemented**. PR: staged together with the capability
wiring (`memory_history` tool, `memory.ts`, `capability.ts`).

## Attribution

Patterns derived from reading `getzep/graphiti` (Apache-2.0): temporal validity
windows, episode provenance, entity/relationship edges, incremental ingestion,
and hybrid retrieval. Re-expressed in Jarv's own TypeScript over the existing
JSON `FactStore`; no source copied.
