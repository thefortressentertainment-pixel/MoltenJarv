/**
 * Vendor three.js + GLTFLoader into src/ui/vendor/three so the hub web UI can
 * load a 3D viewer with NO bundler (plain ESM script tags). Rewrites the
 * GLTFLoader's `from 'three'` import to the vendored relative module.
 *
 * Run as part of the build (after `npm install three`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const nodeThree = path.join(repo, 'node_modules', 'three');
const outDir = path.join(repo, 'src', 'ui', 'vendor', 'three');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// 1. three core ESM module.
ensureDir(outDir);
const threeSrc = path.join(nodeThree, 'build', 'three.module.js');
if (!fs.existsSync(threeSrc)) {
  console.error('missing three.module.js — run `npm install three` first');
  process.exit(1);
}
fs.copyFileSync(threeSrc, path.join(outDir, 'three.module.js'));

// 2. GLTFLoader (rewrite import from 'three' to './three.module.js').
const loaderSrc = path.join(nodeThree, 'examples', 'jsm', 'loaders', 'GLTFLoader.js');
const loaderOut = path.join(outDir, 'GLTFLoader.js');
const loaderCode = fs.readFileSync(loaderSrc, 'utf8').replace(/\bfrom\s+'three';/g, "from './three.module.js';");
fs.writeFileSync(loaderOut, loaderCode);

// 3. Its dependency BufferGeometryUtils (relative import).
const bufSrc = path.join(nodeThree, 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js');
const bufOut = path.join(outDir, 'BufferGeometryUtils.js');
const bufCode = fs.readFileSync(bufSrc, 'utf8');
fs.writeFileSync(bufOut, bufCode);

// Sanity: verify our rewritten loader references the vendored module.
const check = fs.readFileSync(loaderOut, 'utf8');
if (!check.includes("./three.module.js")) {
  console.error('GLTFLoader import rewrite failed');
  process.exit(1);
}
console.log('vendored three into src/ui/vendor/three: three.module.js, GLTFLoader.js, BufferGeometryUtils.js');
