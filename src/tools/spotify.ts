import type { ToolDefinition } from '../agent/types.js';
import { runAppleScript } from '../computer/index.js';

/**
 * Spotify integration. Uses Spotify's AppleScript deep-link (`open location`)
 * + playback — no UI clicking, no System Events, so no extra macOS
 * Automation/Accessibility prompts beyond the single Automation->Spotify grant.
 * One call plays a playlist/context instead of a dozen UI steps.
 */

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function spotifyTools(): ToolDefinition[] {
  return [
    {
      name: 'spotify_play',
      description:
        'Open and play something in Spotify using a Spotify URI/context. Use spotify:likedsongs for Liked Songs, spotify:playlist:ID for a playlist, spotify:track:ID for a track, spotify:album:ID for an album, or spotify:search:QUERY to play a search. Opens Spotify if needed and starts playback. One call, no UI clicking.',
      inputSchema: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'Spotify URI/context, e.g. spotify:likedsongs or spotify:playlist:37i9dQZF1DXcBWIGoYBM5M.' },
        },
        required: ['uri'],
      },
      consequential: true,
      handler: async (args) => {
        const uri = String(args.uri ?? '').trim();
        if (!/^spotify:[a-z0-9:_-]+$/i.test(uri)) {
          return { ok: false, error: `invalid Spotify URI: "${uri}" (expected spotify:likedsongs or spotify:playlist:ID)` };
        }
        try {
          await runAppleScript(`tell application "Spotify"\n  open location "${esc(uri)}"\n  play\nend tell`);
          return { ok: true, uri };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'spotify_status',
      description: 'Read Spotify status: player state, current track name and artist. Read-only.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        try {
          const out = await runAppleScript(
            'tell application "Spotify"\n  set p to player state\n  set t to ""\n  set a to ""\n  try\n    set t to name of current track\n    set a to artist of current track\n  end try\n  return p & "|" & t & "|" & a\nend tell',
          );
          const [state, track, artist] = out.split('|');
          return { ok: true, state, track, artist };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
