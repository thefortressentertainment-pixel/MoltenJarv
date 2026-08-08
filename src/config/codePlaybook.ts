/**
 * CODE_PLAYBOOK — the coding & housekeeping standards Jarv follows whenever it
 * edits this codebase. Injected verbatim into both system prompts (the TaskRunner
 * used by Telegram/hub tasks, and the conversational Agent), so Jarv codes via
 * Telegram the same way it would in VSCodium — just slower.
 */
export const CODE_PLAYBOOK = `

## Coding & housekeeping (when you edit the Jarv Genie codebase)
This is YOUR repo at /Users/tfe/jarv-genie. Code here the way a careful engineer would.

Understand the code before touching it:
- Repo layout: src/cli (commands/entry), src/agent (Agent loop + TaskRunner), src/tools (tool definitions, registered in src/cli/index.ts buildAgent), src/config, src/memory, src/scheduler, src/ui + src/hub (web), src/telegram, src/voice, test/*.test.ts, docs/.
- TypeScript ESM with ".js" import specifiers; "type": "module"; tests use node:test via npm test.
- Match the existing style: read neighboring files for naming, imports, types, and how tools/helpers are structured. Reuse existing helpers (dataHome, getSecretStore, execFileAsync, appendDelivery, etc.) instead of reimplementing them.
- Before editing, use code_search with SPECIFIC identifiers (function/class names, exact strings) and read the surrounding file. Never guess at an API — check src/ and test/ for how it's actually done.

Change discipline:
- Make ONE precise, verified edit at a time (code_edit). Use file_write_any only to create a genuinely new module, placed in the correct directory (src/tools, src/agent, test/, docs/) following the existing module layout and export conventions.
- Every new behavior ships with a test in test/ matching the existing style (node:test + assert).
- NEVER commit or push unless the user explicitly asks. Leave unrelated files untouched.

Verify before done (non-negotiable):
- After ANY code change, run self_review (typecheck + the full test suite) before telling the user it's done. Do not claim success until typecheck and tests are green.
- If you introduced a regression, fix it. Never leave the build broken or a test red.
- If a task can't finish cleanly (steps run out, blocker), stop HONESTLY: report exactly what's done and what isn't, and leave the build green — never half-written code that breaks compilation.

Housekeeping (non-negotiable):
- Never leave scratch/debug files behind: no dbg-*.ts, tmp-*.ts, *.bak, dump files, or ad-hoc scripts in the repo or workspace. Delete anything temporary you created before finishing.
- Keep the git working tree clean except the changes you intend. Run git status at the end if unsure.
- dist/ and node_modules are generated — never edit them.
- Keep this codebase healthy: after your change, the repo must still build (npm run build), typecheck, and pass its tests.`;
