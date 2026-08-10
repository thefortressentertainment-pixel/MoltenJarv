---
name: dspy-bootstrap
description: Port of stanfordnlp/dspy MIPROv2 + BootstrapFewShot (MIT). Treates of resolved pipeline walls as few-shot corrective examples: maintain a failure log per domain, auto-inject the matched (trace -> root cause -> fix) before retrying, and add a fresh entry every time a new wall is solved. Turns recurring debugging (esp. Blender/paint) from re-derivation into pattern-matching. Pure prompt-level; no Python, no optimizer, RAM-light.
---

# DSPy-style Few-Shot Feedforward (from MIPROv2/BootstrapFewShot)

DSPy's optimizers spend many LM calls to *bootstrap* a prompt from labeled
failures. We can't afford the optimizer on the M1, but the *output* it produces —
a corrective few-shot library — is pure text and costs nothing to keep. Take it:
persist each resolved failure as a compact `(failure trace -> root cause -> fix)`
entry, and inject the matching entry before the next attempt instead of
re-debugging from scratch.

## The loop (apply for ANY multi-step tool/pipeline that keeps failing)
1. CAPTURE: when a step fails, copy the exact error line (not the summary) and the
   full traceback root frame.
2. MATCH: before changing code or re-running, grep the domain's failure log (e.g.
   the `paint-pipeline` skill) for a known line/fix. If matched, apply the recorded
   fix directly and re-run — do not re-derive.
3. ROOT-CAUSE, don't patch symptoms: read the innermost frame. For import errors,
   identify WHICH module imported WHAT and where its `try/except` swallows the
   failure (a silently-undefined name is the classic tell: "X is not defined" after
   an import that printed "CAN NOT BE Imported").
4. CHOOSE a RAM-light fix: for a dep/bind failure, a small `sys.modules` stub (or a
   version pin / sys.path insert) applied BEFORE the failing import is better than
   shipping the whole dependency. Keep pinned versions (e.g. numpy 1.26, scipy 1.13)
   rather than chasing the latest that breaks them.
5. RETRY bounded (reuse `refine_code` / Assertions semantics: deterministic guard,
   corrective tail, ~2 backtracks). Each retry is one small completion, not a re-plan.
6. NEW WALL = NEW EXAMPLE: once a fix is verified working, append a one-line entry
   to that domain's failure log so the next occurrence is pattern-matching, not
   reverse-engineering. The log IS the few-shot set — grow it only on verified fixes.

## Heuristics specific to Jarv's Blender/paint work
- A `NameError: name 'X' is not defined` right after a module import that wrapped
  in `try/except ... print("...CAN NOT BE Imported!!!")` means X lives in a
  bpy/C++ dependency that isn't importable here -> pre-stub that module in
  `sys.modules` with a working pure-trivmesh/numpy equivalent.
- An import resolving to the wrong module (namespace package shadow / missing
  sys.path to a nested package or a built `.so`) shows up as "module 'M' has no
  attribute 'fn'" when M imported fine -> add the built package dir to sys.path.
- API-drift walls: upstream passes a value for an old signature, a pinned lib
  changed semantics (e.g. fast_simplification wants a reduction ratio, not a face
  count) -> adapt the CALL to the pinned version, don't unpin.
- Scoping walls in injected code: a helper fn using a name that the enclosing fn
  only binds LATER -> bind it locally inside the block (aliased) so it's always set.

## Where the few-shot log lives
Domain failure logs are kept as always-on skills: `paint-pipeline` (the remote-GPU
paint host walls). Keep each entry to 3 compact lines so the injected skill stays
under ~5k chars. Follow the existing skill convention (front-matter `name:`,
`description:`, then the log).
