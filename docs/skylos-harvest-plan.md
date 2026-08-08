# Skylos (duriantaco/skylos) — Harvest & Implementation Plan

Reference source: `duriantaco/skylos` (Apache-2.0, 520★) — a local-first static
analysis CLI / AI-code-verification tool that checks repos and PRs for dead code,
security flaws, secrets, quality regressions, dependency CVEs, and common
AI-generated-code mistakes. Its thesis relevant to Jarv: **verify AI-written code
deterministically and locally** — no execution, no LLM judge in the loop — and
return an honest `pass`/`fail`/`incomplete` with explicit *coverage proof*.

Skylos is a Python tool; Jarv is TypeScript/Node. Nothing is copied — each item
below borrows a **pattern** and re-expresses it in Jarv's own style, in keeping
with Apache-2.0. It is the successor/complement to the grok-build, openworker,
Cortex, taste-skill, and graphiti harvests.

## Why Jarv needs it

Jarv already verifies its own code with `self_review` (tests + typecheck) and a
`judge` (LLM-as-judge scoring loop), and ships a SHA-256 hash-chained Delivery
Track Record. What's missing:

- **Deterministic, evidence-backed code verification** — `self_review`/`judge`
  are model/tests-dependent; a code edit can have hallucinated imports that tests
  don't catch and an LLM judge won't deterministically flag.
- **An honest "incomplete"** — Jarv cannot distinguish "clean" from "could not
  prove clean." Skylos's `incomplete` state solves this.
- **A re-runnable attestation** over the delivery chain — the existing hash-chain
  verifies integrity but is not a canonical, timestamp-excluded attestation an
  auditor re-runs to confirm an unchanged verdict.

## What was harvested & implemented (T1, deterministic, RAM-safe)

### 1. Deterministic 3-state `verify_change` (skylos `verify` + `coverage proof`)

- `src/verify.ts`: statically build a local symbol surface (declared/exported
  members) of referenced local modules and flag **phantom references**
  (skylos `SKY-L012`): imported sources that the module does not export.
- Three-state verdict (`verdict`):
  - `pass` (0) — no finding AND every applicable check completed.
  - `fail` (1) — at least one verified finding (takes precedence).
  - `incomplete` (2) — no finding but proof not achievable (third-party import,
    unresolvable/unsupported local module) — **a NON-pass**, degraded rather
    than a false clean.
- Versioned schema-v2 JSON: `{schema_version, tool, status, target, findings[],
  coverage[], summary}` with per-check `coverage` (support/status/reason).
- Deterministic, no execution, no model, no network — decompilation-free; only
  reads the edited file + its relative imports.
- `src/tools/verify.ts`: the `verify_change` immune-system tool (read-only,
  non-consequential), registered. Added to `CORE_TOOLS` (never pinned away) and
  `READ_ONLY_TOOLS`.

### 2. Canonical attestation hardening of the Delivery Track Record (skylos `attestation.py`)

- `src/attest.ts`: canonical SHA-256 over a value via sorted keys / compact
  separators / stable scalars (`canonicalString`), so identical inputs →
  byte-identical digest; the timestamp is surfaced but **excluded** from the
  digest input (skylos discipline).
- `deliverylog.ts`: the chain `ChainManifest` now carries an `attestation`
  digest over `{schema, genesis, count, root}`; `verifyChain()` recomputes and
  compares it (`attestationOk`), so tampering with count/root/genesis is caught
  twice (chain + attestation).

### Tests

`test/skylos.test.ts` — 8 tests (canonical hash order-independence,
reproducible attestation, export collection incl. `as` aliases, import parsing
source vs local binding, phantom-reference finding, third-party→incomplete,
verdict roll-up, missing-file→incomplete). Full suite **376 passing**, typecheck
+ build clean.

## Not ported (documented for T2/T3)

- **Full ai_defect rule set** (TS/JS): assertion-weakening (`SKY-A101`),
  dependency-hallucination (`SKY-D222/D224`), missing-guard, swallowed-error —
  higher ROI but needs a real TS AST; deferred.
- **Agent behavior contracts** (`skylos agent test`, exit 0/1/2) — deterministic
  tool/response assertions over Jarv turns; a good T2 follow-up that reuses the
  same exit-code + evidence discipline.
- **Journaled replay artifact set** (`events.jsonl`/`state.json`/`summary.json` +
  validating loader) — a bigger upgrade to the Delivery Track Record; T2.
- **`llms.txt` / SKILL.md-as-knowledge / dual-agent packaging** — cheap docs,
  deferred.
- **The Python tool itself** (dead-code/security/sca engine, Rust natively,
  MCP, GitHub Action) — Jarv is TypeScript; the *patterns* transfer, the runtime
  doesn't.

## Storage

### Status
- [x] Verify tool + 3-state verdict + coverage
- [x] Canonical attestation in the Delivery Track Record
- [ ] ai_defect rules, behavior contracts, replay artifacts, llms.txt (T2+)

## Attribution

Patterns derived from reading `duriantaco/skylos` (Apache-2.0): the
`verdict`/coverage model and phantom-reference spirit from `skylos verify` +
`core/verify_change_schema.py`, and the canonical timestamp-excluded attestation
from `skylos/defend/attestation.py`. Re-expressed in Jarv's own TypeScript; no
source copied.
