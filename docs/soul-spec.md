# Soul Spec reference

Jarv Genie implements **Soul Spec v0.5** (`clawsouls/soulspec`, Apache-2.0) — an
open standard for persistent agent personas. The normative spec lives upstream
at <https://github.com/clawsouls/soulspec> (`soul-spec-v0.5.md`). This page
records the subset Jarv Genie consumes and how it is wired in.

## Package layout

A soul is a folder with at minimum:

```
soul/
├── soul.json   # metadata (specVersion, name, files.soul, …)
└── SOUL.md     # the persona: personality, principles, boundaries
```

Only `soul.json` + `SOUL.md` are required. Jarv Genie reads `soul.json` for
metadata and injects the `SOUL.md` body into the agent system prompt.

## Where Jarv's soul lives

- Default directory: `~/.jarv-genie/soul/`
- Config: `agent.soulPath` in `~/.jarv-genie/config.json`
- Files: `soul.json` (specVersion `0.5`) and `SOUL.md`

## Injection

The single choke point is `src/agent/agent.ts` (`Agent.loop`): the soul body is
appended to the configured system prompt on every run, so it applies uniformly
to REPL, one-shot, hub UI, remote, scheduler, and MCP modes. The stored
`~/.jarv-genie/config.json` system prompt is left untouched.

- Loader: `src/config/soul.ts` (`loadSoul`, `composeSystemPrompt`)
- Supported spec versions: `0.3`, `0.4`, `0.5`
- Missing or invalid souls are a no-op (never fatal).

## Progressive disclosure

- Level 1 (scan): `soul.json` — used for discovery/metadata.
- Level 2 (active use): `SOUL.md` — injected into the system prompt.
- Level 3 (deep): `IDENTITY.md`, `AGENTS.md`, `STYLE.md`, `HEARTBEAT.md` —
  supported by the spec; Jarv Genie currently loads only Level 2.

## Editing

```bash
$EDITOR ~/.jarv-genie/soul/SOUL.md   # changes apply on the next message
```

Run `npm test` for the soul loader/composition tests.
