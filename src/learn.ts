import fs from 'node:fs';
import path from 'node:path';

/**
 * Self-learning skill caching (JARVIS blueprint §C6, ported from OS-Copilot/
 * FRIDAY's "record a reusable procedure after a successful run"; MIT).
 *
 * Jarv's skills dir (`~/.jarv-genie/skills/<name>/SKILL.md`) is loaded into every
 * system prompt. Today skills are hand-authored (e.g. the output-enforcement
 * skill). This makes skill *creation* a learnable, in-band action: after Jarv
 * completes a task it verifies as genuinely successful (optionally passing a
 * judge score), it can record the reusable procedure as a SKILL.md so future
 * similar tasks follow the proven approach — "learn by doing."
 *
 * Safety: skills are advisory instructions only (the reflex + consent gates still
 * apply to every tool they reference). Writing a skill never executes anything.
 */

export interface Frontmatter {
  name: string;
  description: string;
}

/** Slugify a skill title into a dir-safe lowercase-hyphen name. */
export function skillSlug(title: string): string {
  const slug = (title.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .join('-')
    .slice(0, 48)
    // never end a directory on a separator; strip edge punctuation
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled-skill';
}

/** Frontmatter block for a SKILL.md (mirrors the installed skill format). */
export function renderSkillFrontmatter({ name, description }: Frontmatter): string {
  const esc = (s: string) => s.replace(/"/g, '\\"');
  return [
    '---',
    `name: ${esc(name)}`,
    `description: ${esc(description)}`,
    '---',
  ].join('\n');
}

/** Compose the full SKILL.md text from frontmatter + body. */
export function composeSkill(fm: Frontmatter, body: string): string {
  const trimmed = body.trim();
  return `${renderSkillFrontmatter(fm)}\n\n# ${fm.name}\n\n${trimmed}\n`;
}

export interface SaveSkillResult {
  path: string;
  slug: string;
  /** True when a SKILL.md already existed and was overwritten. */
  overwrote: boolean;
}

/** Write a skill to `<dir>/<slug>/SKILL.md`, creating dirs as needed. */
export function saveSkill(dir: string, fm: Frontmatter, body: string): SaveSkillResult {
  const slug = skillSlug(fm.name);
  const skillDir = path.join(dir, slug);
  const file = path.join(skillDir, 'SKILL.md');
  const overwrote = fs.existsSync(file);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(file, composeSkill(fm, body), 'utf8');
  return { path: file, slug, overwrote };
}

/** True when a skill with this title already exists (name-slug match). */
export function skillExists(dir: string, name: string): boolean {
  return fs.existsSync(path.join(dir, skillSlug(name), 'SKILL.md'));
}

/** The judge-score bar below which a run is not clearly successful enough to
 *  generalize into a skill. Matches the judge tool's [-1..+1] scale. */
export const DEFAULT_LEARN_THRESHOLD = 0.35;

/**
 * Decide whether a run is worth distilling into a skill. Mirrors the core
 * pattern from OS-Copilot (only generalize from *verified* successes): when a
 * judge score is supplied and it is below the threshold, do not learn from it.
 * Returns true when the run clears the bar (or when no score was provided —
 * the caller asserts success, e.g. from a delivered-and-verified task).
 */
export function shouldLearn(opts: { judgeScore?: number; threshold?: number }): {
  learn: boolean;
  reason?: string;
} {
  const threshold = opts.threshold ?? DEFAULT_LEARN_THRESHOLD;
  if (opts.judgeScore === undefined) return { learn: true };
  if (opts.judgeScore < threshold) {
    return { learn: false, reason: `judge score ${opts.judgeScore} < threshold ${threshold} — not a clearly successful run to generalize from` };
  }
  return { learn: true };
}
