// Copies UI assets (html/css/js) into dist/ui so the built CLI can serve them.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'ui');
const dest = join(root, 'dist', 'ui');

mkdirSync(dest, { recursive: true });
for (const name of readdirSync(src)) {
  if (name.endsWith('.ts')) continue;
  cpSync(join(src, name), join(dest, name), { recursive: true });
}
console.log('copied ui assets to dist/ui');
