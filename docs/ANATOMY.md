# Jarv's Body Plan — the organism behind the assistant

Jarv is modeled as a living system, not a flat pile of features. Like a human,
it has a **nervous system** that thinks, **senses** that perceive, **limbs** that
act, **organs** that store and filter, an **immune system** that protects, and —
most importantly — an **autonomic nervous system** that keeps the whole organism
stable without conscious thought.

This file is the canonical map: every human part, the Jarv organ it becomes, and
the code that implements it. Status: `[x]` implemented · `[~]` partial · `[ ]` gap.

---

## The organism, top to bottom

```
                    ┌───────────────────────────────────────────┐
                    │      LIMBIC SYSTEM / SOUL (SOUL.md)        │
                    │   identity · instincts · moral anchors     │
                    └───────────────────┬───────────────────────┘
                                        │ colors every decision
                    ┌───────────────────▼───────────────────────┐
                    │         NEOCORTEX (conscious reason)       │
                    │   Model Router + Agent loop / TaskRunner   │
                    │   plan → call tools → observe → reply      │
                    └───────┬───────────────────────┬───────────┘
                            │                       │
              ┌─────────────▼───────────┐   ┌───────▼──────────────┐
              │   SPINAL CORD (reflex)  │   │  PERIPHERAL NERVES   │
              │   hard blocks + fast    │   │   Tool Registry      │
              │   path, before the      │   │   dispatch           │
              │   brain deliberates     │   │                      │
              └─────────────┬───────────┘   └───────┬──────────────┘
                            │                       │
        ┌───────────────────▼───────────────────────▼───────────┐
        │              AUTONOMIC NERVOUS SYSTEM                 │
        │   sense() vitals · regulate() → clean/compact/backoff │
        └───────────────────┬───────────────────────────────────┘
                            │
   ┌────────────┬───────────┼───────────┬────────────┬─────────┐
   │  SENSES    │  ORGANS   │  LIMBS    │  IMMUNE    │  HEART  │
   │  eyes/ears │  memory   │  hands    │  security  │  daemon │
   └────────────┴───────────┴───────────┴────────────┴─────────┘
```

---

## Central nervous system

| Human part | Jarv organ | Implementation | Status |
| --- | --- | --- | --- |
| **Neocortex** — conscious reasoning | Model router + planning loop | `src/providers/` (`ModelRouter`), `src/agent/taskrunner.ts`, `src/agent/agent.ts` | `[x]` |
| **Corpus callosum** — connects hemispheres | Router `primary → fallback` hand-off | `src/providers/index.ts` (DeepSeek ↔ Ollama) | `[x]` |
| **Spinal cord** — reflex, no deliberation | Deterministic hard blocks + routine fast-path, run *before* the model | `src/agent/taskrunner.ts` (`reflexes`) | `[x]` |
| **Autonomic nervous system** — unconscious regulation | `sense()` vitals + `regulate()` (clean/compact/backoff/refuse) | `src/resource.ts` (homeostasis layer) | `[x]` |
| **Peripheral nerves** — signal routing | Tool dispatch | `ToolRegistry.execute` (`src/tools/registry.ts`) | `[x]` |

## Senses

| Human part | Jarv organ | Implementation | Status |
| --- | --- | --- | --- |
| **Eyes** — see the room | Screen + camera capture, vision description | `screen_capture`, `camera_capture` (`src/tools/computer.ts`, `src/tools/camera.ts`) | `[x]` |
| **Reading** — see text | On-device OCR | `screen_read` (`extractScreenText`, `screen_ocr`) | `[x]` |
| **Ears** — hear | Wake word + speech-to-text | `src/voice/wake.ts`, whisper transcription | `[x]` |
| **Mouth** — speak | Text-to-speech | `speak_text`, Piper / macOS `say` (`src/tools/speech.ts`) | `[x]` |
| **Proprioception** — know your own body | Machine vitals: battery, disk, CPU, memory, network | `system_status`, `process_list`, `app_status` (`src/tools/status.ts`) | `[x]` |

## Organs (storage & processing)

| Human part | Jarv organ | Implementation | Status |
| --- | --- | --- | --- |
| **Heart** — pumps work through the system | Scheduled agent daemon | `src/index.ts` agent mode, cron (`src/scheduler/`) | `[x]` |
| **Blood** — transports information | Session store + recent-context circulation | `src/memory/sessions.ts`, `src/agent/recentContext.ts` | `[x]` |
| **Lungs** — draw in and release | Streaming intake / SSE token flow | `streamChat`, `src/ui/server.ts` | `[x]` |
| **Gut + microbiome** — digest and make meaning | Semantic memory + embeddings ecosystem | `src/memory/store.ts`, `embeddings.ts`, `search.ts` | `[x]` |
| **Liver** — filter what's toxic | Context pruning (`trimHistory`, working-context trim) | `src/agent/agent.ts`, `src/agent/taskrunner.ts` | `[x]` |
| **Kidneys** — excrete waste | Temp/drawing cleanup, checkpoint clearing | `src/resource.ts` (`pruneDrawings`, `pruneTemp`) | `[x]` |
| **Fat / long-term stores** | Durable fact memory | `facts.json` (`src/memory/store.ts`) | `[x]` |
| **Sleep / circadian rhythm** — consolidate | Checkpoint + resume for interrupted tasks | `src/agent/checkpoint.ts` | `[x]` |

## Limbs (effectors — the hands)

| Human part | Jarv organ | Implementation | Status |
| --- | --- | --- | --- |
| **Hands** — fine motor | Code edit, file write, drawing | `code_edit` (`src/tools/code.ts`), file tools, `draw_shape` | `[x]` |
| **Arms** — reach and manipulate | App control, shell, UI automation | `app_command`, `run_shell`, `ui_*` (`src/tools/apps.ts`, `system.ts`, `ui.ts`) | `[x]` |
| **Fingers** — precise keystrokes | UI typing / keys | `ui_type`, `ui_key` (`src/tools/ui.ts`) | `[x]` |
| **Legs** — travel to other devices | Device sidecars + remote hub | `src/sidecar/devices.ts`, `src/remote/client.ts` | `[x]` |

## Immune system (defense)

| Human part | Jarv organ | Implementation | Status |
| --- | --- | --- | --- |
| **Skin** — the barrier | Hub auth, Tailscale boundary, 0600 secrets | `src/hub/auth.ts`, `src/config/secrets.ts` | `[x]` |
| **White blood cells** — attack intruders | Credential guard, phish-flagging, treat other AIs as unvetted | Reflexes (`taskrunner`), Moltbook guardrails, prompt rules | `[x]` |
| **Memory of past threats** | Learned security adaptation | *gap* — see below | `[ ]` |

## Endocrine system (drives & hormones)

| Human part | Jarv organ | Implementation | Status |
| --- | --- | --- | --- |
| **Hormones** — proactive drives | Initiative engine, proactive scans, self-review | `src/initiatives.ts`, `src/tools/initiative.ts`, `self_review` | `[x]` |
| **Circadian rhythm** — time-based drives | Cron schedules, monitors, briefings | `src/scheduler/`, `src/tools/briefing.ts` | `[x]` |

## The soul — limbic system

| Human part | Jarv organ | Implementation | Status |
| --- | --- | --- | --- |
| **Amygdala / limbic core** — identity, instincts, values | SOUL.md persona injected into every prompt | `src/config/soul.ts` (now wired into both `Agent` and `TaskRunner`, so Telegram and hub carry it) | `[x]` |

---

## Organ tagging

Every tool is tagged with the body system it belongs to (`ToolDefinition.system`):

- `sense` — perception: eyes, ears, reading, proprioception
- `effector` — action: hands, arms, fingers, legs
- `memory` — storage and recall
- `voice` — speaking and hearing surfaces
- `autonomic` — self-regulation, monitors, scheduler, shutdown
- `immune` — defense and verification
- `integration` — external channels: Telegram, web, calendar, email, Moltbook, initiative

The registry exposes `bySystem()`, `senses()`, `effectors()`, and `organs()` so
the agent can *reason about its own body*: "what can you see?" is now a real
query over tagged tools.

---

## Gaps — the body that is not yet grown

- `[ ]` **Immune memory** — a learning adaptive security layer (recall past
  threats, tighten guardrails over time). Today's defense is static rules +
  reflex blocks; the memory of *past* attacks is not yet learned and stored.
- `[ ]` **Conscious attention** — a salience layer that decides what is worth
  the cortex's attention (today everything gets full reasoning, even trivial
  turns).
- `[ ]` **Growth / development** — self-directed capability extension beyond the
  optimization loop (today Jarv proposes changes but the human applies them).

These are deliberate future work, not part of the current build.
