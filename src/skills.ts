import fs from 'node:fs';
import path from 'node:path';

/**
 * Skills — a zero-code extension convention modeled on grok-build's plugin
 * marketplace scanner (`plugins/<name>/skills/<skill>/SKILL.md`, Apache-2.0).
 *
 * Any directory under `JARV_HOME/skills/<skill>/SKILL.md` is loaded at startup
 * and injected into the system prompt as an instruction block the assistant
 * follows. Users can add skills by dropping in a markdown file — no code, no
 * registry change — and a future marketplace needs no schema update.
 *
 * Safety: only `SKILL.md` reads, never shell/exec. A skill is purely advisory
 * instructions; the reflex + consent gates still apply to all its tool uses.
 */

export interface Skill {
  name: string;
  body: string;
}

/**
 * Load all skills from `<dir>/<skillName>/SKILL.md`. Synchronous to match the
 * soul loader (`loadSoul`) so it can be composed into the system prompt. Reads
 * are fail-open: a missing/evil skill never aborts the others.
 */
export function loadSkills(dir: string): Skill[] {
  const out: Skill[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
  } catch {
    return out; // no skills dir yet
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const mdPath = path.join(dir, name, 'SKILL.md');
    let body: string;
    try {
      body = fs.readFileSync(mdPath, 'utf8');
    } catch {
      continue; // no SKILL.md in this folder
    }
    const trimmed = body.trim();
    if (!trimmed) continue;
    out.push({ name, body: trimmed });
  }
  return out;
}

/** Render loaded skills into a system-prompt instruction block (empty when none). */
export function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const blocks = skills.map((s) => `### Skill: ${s.name}\n${s.body}`).join('\n\n');
  return `\n\nYou have the following always-on skills loaded from ${skills.length} skill file(s). Follow them whenever applicable:\n\n${blocks}`;
}
