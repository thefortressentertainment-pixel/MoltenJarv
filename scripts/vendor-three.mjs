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

// 1. three core ESM module + its internal three.core dependency.
ensureDir(outDir);
const threeSrc = path.join(nodeThree, 'build', 'three.module.js');
if (!fs.existsSync(threeSrc)) {
  console.error('missing three.module.js — run `npm install three` first');
  process.exit(1);
}
fs.copyFileSync(threeSrc, path.join(outDir, 'three.module.js'));
// three.module.js imports './three.core.js'; vendor that too so the ESM resolves.
const threeCore = path.join(nodeThree, 'build', 'three.core.js');
if (fs.existsSync(threeCore)) fs.copyFileSync(threeCore, path.join(outDir, 'three.core.js'));

// 2. GLTFLoader (rewrite imports: 'three' -> ./three.module.js, and the two
//    utils to same-dir so they resolve).
const loaderSrc = path.join(nodeThree, 'examples', 'jsm', 'loaders', 'GLTFLoader.js');
const loaderOut = path.join(outDir, 'GLTFLoader.js');
let loaderCode = fs.readFileSync(loaderSrc, 'utf8')
  .replace(/\bfrom\s+'three';/g, "from './three.module.js';")
  .replace(/\bfrom\s+'\.\.\/utils\/BufferGeometryUtils\.js';/g, "from './BufferGeometryUtils.js';")
  .replace(/\bfrom\s+'\.\.\/utils\/SkeletonUtils\.js';/g, "from './SkeletonUtils.js';");
fs.writeFileSync(loaderOut, loaderCode);

// 2b. Its utils deps, with 'three' import rewrites to the vendored module.
function vendorEsm(relPath, name) {
  const src = path.join(nodeThree, relPath);
  const out = path.join(outDir, name);
  if (!fs.existsSync(src)) { console.error('missing ' + relPath); process.exit(1); }
  const code = fs.readFileSync(src, 'utf8').replace(/\bfrom\s+'three';/g, "from './three.module.js';");
  fs.writeFileSync(out, code);
}
vendorEsm('examples/jsm/utils/BufferGeometryUtils.js', 'BufferGeometryUtils.js');
vendorEsm('examples/jsm/utils/SkeletonUtils.js', 'SkeletonUtils.js');

// Sanity: verify our rewritten loader references the vendored module.
const check = fs.readFileSync(loaderOut, 'utf8');
if (!check.includes("./three.module.js")) {
  console.error('GLTFLoader import rewrite failed');
  process.exit(1);
}
console.log('vendored three into src/ui/vendor/three: three.module.js, GLTFLoader.js, BufferGeometryUtils.js');
