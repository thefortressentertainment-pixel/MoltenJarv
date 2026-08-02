import path from 'node:path';
import { VERSION } from '../config/defaults.js';
import { getLinkStore } from '../remote/client.js';
import {
  cmpVersion,
  fetchManifest,
  publishUpdate,
  readManifest,
  updatesDir,
} from '../updates/index.js';

export async function runUpdateCommand(argv: string[]): Promise<void> {
  const sub = argv[0];

  if (sub === 'publish') {
    const artifact = argv[1];
    if (!artifact) {
      process.stderr.write('Usage: jarv-genie update publish <file.dmg|file.app> [--version X] [--notes "..."]\n');
      process.exit(1);
    }
    const version = argv.find((a, i) => argv[i - 1] === '--version');
    const notes = argv.find((a, i) => argv[i - 1] === '--notes');
    try {
      const m = publishUpdate(path.resolve(artifact), { version, notes });
      process.stdout.write(
        `Published jarv-genie v${m.version} (${m.artifactSize} bytes, sha256 ${m.sha256.slice(0, 12)}…) to ${updatesDir()}\n`,
      );
      if (m.notes) process.stdout.write(`  ${m.notes}\n`);
      process.stdout.write('Serve it from the hub (`GET /api/update`); clients check automatically when linked.\n');
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'list' || sub === undefined) {
    const m = readManifest();
    if (!m) {
      process.stdout.write('Nothing published yet — `jarv-genie update publish <file> [--version X]` stages a build for distribution.\n');
      return;
    }
    process.stdout.write(`Published: v${m.version}  ${m.artifact}  (${m.publishedAt})\n`);
    if (m.notes) process.stdout.write(`  ${m.notes}\n`);
    return;
  }

  if (sub === 'check') {
    const urlArg = argv.find((a, i) => argv[i - 1] === '--url');
    const linked = getLinkStore().get();
    const base = (urlArg ?? '') || (argv.includes('--remote') || argv.includes('--url') ? linked?.url : undefined);
    const token = base && linked?.url && base.replace(/\/+$/, '') === linked.url.replace(/\/+$/, '') ? linked.token : undefined;

    if (!base) {
      const m = readManifest();
      if (m && cmpVersion(m.version, VERSION) > 0) {
        process.stdout.write(`Update available: v${VERSION} → v${m.version} (published locally)\n`);
        return;
      }
      process.stdout.write(`jarv-genie v${VERSION} — up to date\n`);
      return;
    }

    try {
      const m = await fetchManifest(base, token);
      if (!m) {
        process.stdout.write(`jarv-genie v${VERSION} — up to date (${base} has nothing published)\n`);
        return;
      }
      const cmp = cmpVersion(m.version, VERSION);
      if (cmp > 0) {
        process.stdout.write(`Update available: v${VERSION} → v${m.version} at ${base}\n`);
        if (m.notes) process.stdout.write(`  ${m.notes}\n`);
      } else {
        process.stdout.write(`jarv-genie v${VERSION} — up to date (latest is v${m.version})\n`);
      }
    } catch (err) {
      process.stderr.write(`error: could not reach ${base}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return;
  }

  process.stderr.write(`Usage:\n  jarv-genie update publish <file> [--version X] [--notes "..."]\n  jarv-genie update list\n  jarv-genie update check [--url <hub>] [--remote]\n`);
  process.exit(1);
}
