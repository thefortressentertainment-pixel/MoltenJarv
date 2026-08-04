import fs from 'node:fs';
import path from 'node:path';

/**
 * Soul Spec (clawsouls/soulspec) loader.
 *
 * A soul is a folder containing at minimum `soul.json` (metadata) and
 * `SOUL.md` (the persona itself). The SOUL.md content is injected into the
 * system prompt on every agent run so the persona survives across sessions,
 * model swaps, and context compaction.
 *
 * Missing or invalid souls are treated as "no soul" — never fatal.
 */

export const SOUL_SPEC_VERSION = '0.5';
export const SUPPORTED_SPEC_VERSIONS = ['0.3', '0.4', '0.5'];

export interface Soul {
  name: string;
  displayName: string;
  specVersion: string;
  content: string;
  path: string;
}

export function loadSoul(soulDir: string | undefined): Soul | null {
  if (!soulDir) return null;
  try {
    const manifestPath = path.join(soulDir, 'soul.json');
    if (!fs.existsSync(manifestPath)) return null;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      specVersion?: string;
      name?: string;
      displayName?: string;
      files?: { soul?: string };
    };

    if (!manifest.specVersion || !SUPPORTED_SPEC_VERSIONS.includes(manifest.specVersion)) return null;

    const soulFile = manifest.files?.soul ?? 'SOUL.md';
    const soulPath = path.join(soulDir, soulFile);
    if (!fs.existsSync(soulPath)) return null;

    const content = fs.readFileSync(soulPath, 'utf8');
    const name = manifest.name ?? 'soul';
    return {
      name,
      displayName: manifest.displayName ?? name,
      specVersion: manifest.specVersion,
      content,
      path: soulPath,
    };
  } catch {
    return null;
  }
}

/** Append the soul persona to the base system prompt (no-op when absent). */
export function composeSystemPrompt(systemPrompt: string, soul: Soul | null): string {
  if (!soul) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n# Soul: ${soul.displayName}\n\n${soul.content.trim()}`;
}
