// Jarv Genie — in-browser 3D viewer for Jarv's Blender work.
// Loads the vendored three.js + GLTFLoader (ESM, no bundler) and renders the
// exported GLB preview (/preview.glb) with orbit controls emulated via drag.
import * as THREE from '/vendor/three/three.module.js';
import { GLTFLoader } from '/vendor/three/GLTFLoader.js';

// Reuse the same auth token the chat app stores.
function authHeaders() {
  const token = localStorage.getItem('jarvGenieToken');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const viewer = document.getElementById('viewer');
const canvasWrap = document.querySelector('.viewer-canvas-wrap');
const canvas = document.getElementById('viewerCanvas');
const exportBtn = document.getElementById('viewerExportBtn');
const closeBtn = document.getElementById('viewerClose');

let renderer;
let scene;
let camera;
let controller;
let modelLoaded = false;

function showLog(container, msg) {
  container.append(Object.assign(document.createElement('div'), { textContent: msg, className: 'viewer-log' }));
}

function ensureScene() {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1e1e2a);
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(5, 3, 6);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(5, 8, 6);
    scene.add(keyLight);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 0.5);
    scene.add(hemi);
    // Simple orbit: rotate via drag + wheel zoom.
    controller = {
      theta: 0.6, phi: 0.4, radius: 8,
      // -- helper object not needed; we track state + an interactive marker
    };
    setupDrag();
    const resize = () => {
      const w = canvasWrap.clientWidth || 640;
      const h = canvasWrap.clientHeight || 480;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);
    animate();
  } else {
    // already built; just ensure the marker still exists
  }
}

function animate() {
  requestAnimationFrame(animate);
  if (camera && controller) {
    const cx = controller.radius * Math.sin(controller.phi) * Math.cos(controller.theta);
    const cy = controller.radius * Math.cos(controller.phi);
    const cz = controller.radius * Math.sin(controller.phi) * Math.sin(controller.theta);
    camera.position.set(cx, cy, cz);
    camera.lookAt(0, 0.5, 0);
  }
  renderer?.render(scene, camera);
}

function setupDrag() {
  let dragging = false, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    controller.theta += (e.clientX - lx) * 0.01;
    controller.phi = Math.max(0.1, Math.min(Math.PI - 0.1, controller.phi + (e.clientY - ly) * 0.01));
    lx = e.clientX; ly = e.clientY;
  });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); controller.radius = Math.max(1, Math.min(50, controller.radius + e.deltaY * 0.01)); }, { passive: false });
}

function clearModel() {
  if (scene) {
    while (scene.children.length > 0) scene.remove(scene.children[0]);
  }
  modelLoaded = false;
}

async function loadPreview() {
  ensureScene();
  clearModel();
  try {
    const res = await fetch('/preview.glb', { headers: authHeaders() });
    if (!res.ok) {
      if (res.status === 404) throw new Error('no exported preview yet — click "Export from Blender" first');
      throw new Error(`preview fetch failed: HTTP ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    await new Promise((resolve, reject) => {
      new GLTFLoader().parse(buf, '', (gltf) => {
        const s = gltf.scene;
        const box = new THREE.Box3().setFromObject(s);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        s.position.sub(center);
        controller.radius = maxDim * 2.5;
        scene.add(s);
        modelLoaded = true;
        resolve();
      }, (err) => reject(err));
    });
  } catch (err) {
    // The viewer opened but there's no model yet; keep empty so the user can export.
    showLog(canvasWrap, `⚠️ ${err instanceof Error ? err.message : String(err)}`);
  }
}

viewer.querySelector('#viewerExportBtn').addEventListener('click', async () => {
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting…';
  try {
    const res = await fetch('/api/blender/export', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' } });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      throw new Error(body.error || `export failed: HTTP ${res.status}`);
    }
    await loadPreview();
  } catch (err) {
    showLog(canvasWrap, `⚠️ ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = 'Export from Blender';
  }
});

closeBtn.addEventListener('click', () => viewer.classList.add('hidden'));

// Refine: send a prompt to Jarv (build/refine in the live Blender), then refresh
// the preview so you SEE the result. This closes the render-refine-view loop.
const refineBtn = document.getElementById('viewerRefineBtn');
const refineInput = document.getElementById('viewerRefineInput');

async function refineLive() {
  const msg = (refineInput.value || '').trim();
  if (!msg) return;
  refineBtn.disabled = true;
  refineBtn.textContent = 'Sending…';
  showLog(canvasWrap, `🧊 sending: ${msg}`);
  try {
    const res = await fetch('/api/blender', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error((body && body.error) || `build failed: HTTP ${res.status}`);
    showLog(canvasWrap, `✅ Jarv: ${(body && body.text) ? body.text.slice(0, 160) : 'done'}`);
    // Re-export and show the updated model.
    const ex = await fetch('/api/blender/export', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' } });
    const bx = await ex.json();
    if (!ex.ok || !bx.ok) throw new Error((bx && bx.error) || 'export failed');
    await loadPreview();
  } catch (err) {
    showLog(canvasWrap, `⚠️ ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    refineBtn.disabled = false;
    refineBtn.textContent = 'Refine';
    refineInput.value = '';
  }
}
if (refineBtn) refineBtn.addEventListener('click', refineLive);
if (refineInput) refineInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refineLive(); });

// Hub Blender build bar: prompt Jarv to build/refine in the LIVE open Blender,
// then re-export and render it in the viewer. Reuses the same {ok,text}|{error}
// endpoint contract as the viewer's Refine box.
const blenderBar = document.querySelector('.blender-bar');
const blenderInput = document.getElementById('blenderInput');
const blenderSend = document.getElementById('blenderSend');
const blenderStatus = document.getElementById('blenderStatus');
const blenderView = document.getElementById('blenderView');

// Reflect live-bridge state on the bar (best-effort; a 409 means Blender is closed).
async function refreshBlenderStatus() {
  if (!blenderStatus) return;
  try {
    const res = await fetch('/preview.glb', { headers: authHeaders() });
    blenderStatus.textContent = res.ok
      ? 'live — last build ready to view'
      : blenderView && blenderView.dataset.pending ? 'building…' : 'not live — open Blender with the Jarv add-on';
    blenderStatus.classList.toggle('on', res.ok);
  } catch {
    blenderStatus.textContent = 'not live — open Blender with the Jarv add-on';
    blenderStatus.classList.remove('on');
  }
}

async function hubBuild() {
  const msg = (blenderInput.value || '').trim();
  if (!msg) return;
  blenderSend.disabled = true;
  blenderSend.textContent = 'Building…';
  blenderBar.classList.add('blender-busy');
  showLog(canvasWrap, `🧊 sending: ${msg}`);
  try {
    const res = await fetch('/api/blender', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error((body && body.error) || `build failed: HTTP ${res.status}`);
    showLog(canvasWrap, `✅ Jarv: ${(body && body.text) ? body.text.slice(0, 160) : 'done'}`);
    // Re-export and show the updated model in the viewer.
    const ex = await fetch('/api/blender/export', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' } });
    const bx = await ex.json();
    if (!ex.ok || !bx.ok) throw new Error((bx && bx.error) || 'export failed');
    await loadPreview();
    refreshBlenderStatus();
  } catch (err) {
    showLog(canvasWrap, `⚠️ ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    blenderSend.disabled = false;
    blenderSend.textContent = 'Build';
    blenderBar.classList.remove('blender-busy');
    refreshBlenderStatus();
  }
}

if (blenderSend) blenderSend.addEventListener('click', hubBuild);
if (blenderInput) blenderInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') hubBuild(); });
if (blenderView) blenderView.addEventListener('click', () => {
  viewer.classList.remove('hidden');
  blenderView.dataset.pending = '1';
  loadPreview();
});
refreshBlenderStatus();

// Expose a global so the chat UI can open the viewer.
window.JarvViewer = {
  open() { viewer.classList.remove('hidden'); loadPreview(); refreshBlenderStatus(); },
  refresh() { loadPreview(); },
};
