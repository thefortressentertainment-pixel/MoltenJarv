import { createInterface } from 'node:readline';
import path from 'node:path';
import { dataHome } from '../config/defaults.js';
import { getSecretStore } from '../config/secrets.js';

const USAGE =
  'Usage:\n' +
  '  jarv-genie key set <name> [value]   store a secret (prompts hidden if value omitted)\n' +
  '  jarv-genie key rm <name>            remove a secret\n' +
  '  jarv-genie key list                 list stored secrets (values masked)\n';

function mask(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/** Read a line without echoing it back to the terminal. */
function promptHidden(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const hidden = rl as unknown as { _writeToOutput: (str: string) => void };
    const orig = hidden._writeToOutput.bind(rl);
    hidden._writeToOutput = (str: string) => {
      if (rl.line.length === 0) orig(str);
    };
    rl.question(promptText, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      data += c;
    });
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

async function inputOrStdin(promptText: string): Promise<string> {
  return process.stdin.isTTY ? promptHidden(promptText) : readStdin();
}

/** `jarv-genie key <set|rm|list> ...` — developer-facing secret management. */
export async function runKeyCommand(argv: string[]): Promise<void> {
  const store = getSecretStore();
  const sub = argv[0] ?? 'list';

  switch (sub) {
    case 'set': {
      const name = argv[1];
      let value = argv[2];

      if (!name) {
        process.stdout.write('Key name (e.g. OPENAI_API_KEY): ');
        const raw = await readStdin();
        if (!raw) {
          process.stdout.write('aborted: no name given\n');
          return;
        }
        value = await inputOrStdin('Value (input hidden): ');
        await store.set(raw, value);
        process.stdout.write(`Saved ${raw} to ${storeFile()}\n`);
        return;
      }
      if (!value) value = await inputOrStdin(`Value for ${name} (input hidden): `);
      if (!value) {
        process.stdout.write('aborted: no value given\n');
        return;
      }
      store.set(name, value);
      process.stdout.write(`Saved ${name} to ${storeFile()}\n`);
      return;
    }

    case 'rm': {
      const name = argv[1];
      if (!name) {
        process.stdout.write('key rm requires a name\n');
        return;
      }
      process.stdout.write(store.remove(name) ? `Removed ${name}\n` : `No secret named ${name}\n`);
      return;
    }

    case 'list': {
      const names = store.list();
      if (names.length === 0) {
        process.stdout.write('No stored secrets. Use: jarv-genie key set <name>\n');
        return;
      }
      for (const n of names) {
        const v = store.get(n);
        process.stdout.write(`  ${n}: ${v ? mask(v) : '(empty)'}\n`);
      }
      return;
    }

    default:
      process.stdout.write(USAGE);
  }
}

function storeFile(): string {
  return path.join(dataHome(), 'secrets.json');
}
