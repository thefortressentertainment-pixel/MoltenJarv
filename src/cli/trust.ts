import { trustedPolicy, configurePolicy, fullAutoSet, executeMode, DEFAULT_NEVER_AUTO, trustedDeviceChatId } from '../telegram/trust.js';

/**
 * `jarv-genie trust [status|execute|confirm|allow <tool>|deny <tool>|list]`
 *
 * View/configure the trusted-executor policy for the verified device.
 *  - `status`           show the current policy.
 *  - `execute`          enable full-autonomy mode (tools explicitly allow-listed run without asking).
 *  - `confirm`          back to confirm mode (default; safe).
 *  - `allow <tool>`     add a tool to the full-auto allowlist (only then does it run in execute mode).
 *  - `deny <tool>`      remove a tool from the allowlist (it will ask again).
 *  - `list`             list the allowlist + always-confirm set.
 */
export async function runTrustCommand(argv: string[]): Promise<void> {
  const sub = argv[0] ?? 'status';
  const tool = argv[1];

  if (!trustedDeviceChatId()) {
    process.stdout.write('No verified device yet — run `jarv-genie pair` to pair one first.\n');
    return;
  }

  switch (sub) {
    case 'status':
    case 'list': {
      const p = trustedPolicy();
      process.stdout.write(`Mode: ${p.mode}\n`);
      process.stdout.write(`Allow-listed (run without asking in execute mode): ${p.fullAuto.length ? p.fullAuto.join(', ') : '(none — everything asks)'}\n`);
      process.stdout.write(`Always-confirm (unless explicitly allow-listed): ${p.neverAuto.join(', ')}\n`);
      const custom = [...fullAutoSet()].filter((t) => !p.neverAuto.includes(t));
      process.stdout.write(`Custom allow-listed tools: ${custom.length ? custom.join(', ') : '(none)'}\n`);
      process.stdout.write('Hint: `jarv-genie trust execute` then `allow <tool>` per trusted tool.\n');
      return;
    }
    case 'execute': {
      configurePolicy({ mode: 'execute' });
      process.stdout.write(`Set mode to **execute**. Now allow the tools you trust, e.g.: jarv-genie trust allow run_shell\n`);
      return;
    }
    case 'confirm': {
      configurePolicy({ mode: 'confirm' });
      process.stdout.write('Set mode to **confirm** (everything asks again).\n');
      return;
    }
    case 'allow': {
      if (!tool) { process.stdout.write('usage: jarv-genie trust allow <tool>\n'); return; }
      configurePolicy({ addAuto: [tool] });
      process.stdout.write(`Allow-listed ${tool}. It now runs without asking in execute mode.\n`);
      return;
    }
    case 'deny': {
      if (!tool) { process.stdout.write('usage: jarv-genie trust deny <tool>\n'); return; }
      configurePolicy({ removeAuto: [tool] });
      process.stdout.write(`Removed ${tool} from the allowlist; it will ask again.\n`);
      return;
    }
    default:
      process.stdout.write(
        'usage:\n' +
          '  jarv-genie trust status | list\n' +
          '  jarv-genie trust execute | confirm\n' +
          '  jarv-genie trust allow <tool> | deny <tool>\n',
      );
  }
}
