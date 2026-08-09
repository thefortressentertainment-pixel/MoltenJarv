/**
 * `bpy_polyhaven` — real CC0 PBR textures + HDRIs into the live scene.
 *
 * Pattern adapted from `dhakalnirajan/blender-open-mcp` (permissive MIT-style
 * license) + the PolyHaven public API. PolyHaven assets are CC0 (public domain),
 * so this is license-clean. Re-expressed concisely for Jarv's RAM-light runner.
 *
 * WHY: Jarv's default materials are flat single colors. For a "1:1 mesh render
 * from a reference photo" the big win is REAL materials + REAL lighting — pulling
 * an actual CC0 leather/wood/skin texture or a studio HDRI from PolyHaven and
 * applying it in the open Blender. That makes renders far more photographic than
 * a flat color map, with near-zero RAM (on-demand HTTP download into the
 * already-open Blender; no GPU, no resident models).
 */

const API = 'https://api.polyhaven.com';

export interface PolyHavenAsset {
  id: string;
  name: string;
  type: 'textures' | 'hdris' | 'models';
  categories?: string[];
}

/** Search PolyHaven's public CC0 library for assets matching a keyword + type.
 *  Returns the closest matches (bounded) so Jarv can pick one. */
export async function searchPolyHavenAssets(
  query: string,
  type: 'textures' | 'hdris' | 'models' = 'textures',
  limit = 12,
): Promise<{ ok: boolean; assets: PolyHavenAsset[]; error?: string }> {
  try {
    const cat = (query || '').trim().toLowerCase().replace(/\s+/g, '_');
    const url = cat ? `${API}/assets?type=${type}&categories=${encodeURIComponent(cat)}` : `${API}/assets?type=${type}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, assets: [], error: `PolyHaven HTTP ${res.status}` };
    const data = (await res.json()) as Record<string, { name?: string; categories?: string[] }>;
    const items = Object.entries(data)
      .filter(([, v]) => !(v?.name && v.name.toLowerCase().startsWith('__')))
      .slice(0, limit)
      .map(([id, v]) => ({ id, name: v?.name ?? id, categories: v?.categories, type }));
    return { ok: items.length > 0, assets: items };
  } catch (err) {
    return { ok: false, assets: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Resolve the downloadable file URL for a PolyHaven asset. For textures we want
 *  the Diffuse/Color map; for HDRIs the equirectangular `hdri` entry. Returns the
 *  resolved {url, ext, resolution} or an error. */
export async function resolvePolyHavenFile(
  assetId: string,
  type: 'textures' | 'hdris',
  resolution = '1k',
): Promise<{ ok: boolean; url?: string; ext?: string; resolution?: string; error?: string }> {
  try {
    const filesRes = await fetch(`${API}/files/${assetId}`, { signal: AbortSignal.timeout(15_000) });
    if (!filesRes.ok) return { ok: false, error: `PolyHaven files HTTP ${filesRes.status}` };
    const files = (await filesRes.json()) as Record<string, unknown>;
    let entry: { url?: string } | undefined;
    if (type === 'hdris') {
      const hdri = (files as Record<string, Record<string, Record<string, { url?: string } | string>>>)?.['hdri'];
      const r = hdri?.[resolution];
      entry = (r && (typeof r === 'object' ? r['hdr'] ?? r['exr'] : undefined)) as { url?: string } | undefined;
    } else {
      const mapNode = (files as Record<string, Record<string, Record<string, { url?: string } | string>>>)?.['Diffuse']
        ?? (files as Record<string, Record<string, Record<string, { url?: string } | string>>>)?.['Color'];
      const r = mapNode?.[resolution];
      entry = (r && (typeof r === 'object' ? r['jpg'] ?? r['png'] : undefined)) as { url?: string } | undefined;
    }
    if (!entry?.url) return { ok: false, error: `no ${resolution} download for '${assetId}'` };
    return { ok: true, url: entry.url, ext: type === 'hdris' ? 'hdr' : entry.url.split('.').pop() ?? 'jpg', resolution };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Download the resolved texture/HDRI to a local temp path. Returns the path. */
export async function downloadPolyHavenFile(url: string, dest: string): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return dest;
}

export const POLYHAVEN_API = API;
