# Taste Skill — Harvest Note

Source: `Leonxlnx/taste-skill` (MIT, 74.2k★) — "gives your AI good taste. stops the
AI from generating boring, generic slop." A collection of portable `SKILL.md` files
(the "Anti-Slop Frontend Framework"), not code.

## What was harvested

**Output Skill** (`full-output-enforcement`, `skills/output-skill/SKILL.md`) — the
most broadly applicable skill in the repo because it applies to code AND written
deliverables, not just frontend design. It enforces complete output and bans
placeholder/truncation patterns:

- Banned in code: `// ...`, `// rest of code`, `// TODO`/`// implement here`,
  `/* ... */`, `// similar to above`, bare `...` standing in for omitted code.
- Banned in prose: "let me know if you want me to continue", "for brevity",
  "I'll leave that as an exercise", etc.
- Long outputs use the clean `[PAUSED — X of Y complete. Send "continue"...]`
  handoff instead of compressing or skipping sections.

## Where it's active

Installed to Jarv's auto-loaded skills dir:
`~/.jarv-genie/skills/output/SKILL.md`

Jarv loads every `<skills>/<name>/SKILL.md` into the system prompt at startup
(`src/skills.ts`), so the rules apply on every task.

## Not harvested (by design)

The other variants (`taste-skill` [87KB frontend], `brutalist`, `minimalist`,
`soft`, `stitch`, image-generation, `redesign`, `gpt-taste`) are frontend-design
focused. They only make sense when Jarv is generating UI, and auto-loading a
large design prompt into every run would bloat Jarv's context. They remain
available from the upstream repo if wanted later.
