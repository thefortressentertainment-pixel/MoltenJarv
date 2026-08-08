# Jarvis Reframe — Trusted Executor

Goal: bring Jarv as close to a J.A.R.V.I.S.-style model as is real and wise.
"Full autonomy" is NOT unbounded freedom — it is **bounded, operator-explicit
autonomy**: a verified device may run tools end-to-end (run, verify, report) with
no per-step ask, but ONLY for tools the operator has explicitly allow-listed, and
only after consciously switching the trusted device into `execute` mode.
Irreversible / off-machine actions remain gated unless explicitly relaxed.

## The trust-tier model

Extended `~/.jarv-genie/trusted-device.json` policy for the verified device:

- **mode: 'confirm'** (default) — today's safe behavior: verified device
  auto-approves non-external actions; irreversible/fail-closed always ask.
- **mode: 'execute'** — full autonomy *for allow-listed tools only*:
  `executorDecision(tool, chat)` returns
  - `not-trusted` → hard gate, never executes,
  - `run` → the verified device executes without asking (only in execute mode AND
    tool in `fullAuto`),
  - `ask` → requires confirmation (everything not explicitly allow-listed).

**always-confirm safety net** (`DEFAULT_NEVER_AUTO`): `shutdown`, `email_send`,
`telegram_send` — these keep requiring
confirmation even in execute mode *unless* the operator explicitly `allow`s one.

## Controls

- `jarv-genie trust status|list` — view the current policy.
- `jarv-genie trust execute` — switch the verified device to full-autonomy mode.
- `jarv-genie trust confirm` — back to safe per-action confirm mode.
- `jarv-genie trust allow <tool>` / `deny <tool>` — edit the allowlist.

## Mechanics

- `src/telegram/trust.ts` — `Policy` record, `executorDecision()`, `configurePolicy()`.
- `src/agent/taskrunner.ts` — the consent batch now excludes `executorDecision===run`
  calls, and the per-call gate skips them (so allow-listed tools execute without ask).
- `src/cli/telegram.ts` — passes the active trusted chat id into the runner live.
- `src/cli/trust.ts` + `jarv-genie trust` — operator CLI.

## Safety invariants

- Full autonomy is ALWAYS bounded by the explicit `fullAuto` allowlist. An
  allow-listed tool is the operator's deliberate choice.
- No new tools gain automatic execution: `ask` is the default for anything not
  allow-listed, and `not-trusted` never runs.
- The `neverAuto` net stays until explicitly relaxed, keeping irreversible/off-machine
  actions gated by default.
- Existing `confirm` behavior is unchanged (mode defaults to confirm).

Tests: 301 passing (7 new trusted-executor), typecheck + build clean.

## Voice/persona reframe (2026-08-08)

The soul (`~/.jarv-genie/soul/SOUL.md`) was refined to a **Refined J.A.R.V.I.S.**
register on top of the existing calm butler-engineer tone. Additions, preserving
all principles/boundaries/operating rules:

- **Personality:** "I'll take care of it" as the default answer (own the task
  end-to-end), and "a step ahead" (anticipate the next need and have it ready).
- **Voice:** the job-closed cadence — quiet assurance, report "Done" with the
  outcome, dry precise one-liners that never outrank the answer.
- **Communication:** signature openers ("I'll take care of it", "Done", "Already
  on it") used only where they land cleanly; never forced.

Not theatrical, no parody, and the joke never outranks substance. The soul is a
live file under `~/.jarv-genie/soul/` (outside the repo, like skills/trust state).

## Voice input via Telegram (2026-08-08)

The bridge now accepts voice/audio messages: it downloads a Telegram `voice`
(OPUS) or `audio` note, converts it to 16 kHz mono WAV (ffmpeg, afconvert/sox
fallbacks), and runs it through Jarv's existing STT (`transcribe()`: local
whisper.cpp first, OpenAI whisper-1 fallback). The transcript is then handled
exactly like a typed message, so "Open YouTube and play X video" is parsed and
acted on through Jarv's normal tools/skills.

- `src/telegram/voice.ts` — download + convert + transcribe.
- `src/cli/telegram.ts` — `onUpdate` detects audio and feeds the transcript in.
- Requires `whisper-cli` + a model (or `OPENAI_API_KEY`) for STT; ffmpeg for
  conversion (all present on this Mac).
