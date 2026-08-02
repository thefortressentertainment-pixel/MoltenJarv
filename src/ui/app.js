'use strict';

const $ = (id) => document.getElementById(id);
const messages = $('messages');
const input = $('input');
const sendBtn = $('sendBtn');
const TOKEN_KEY = 'jarvGenieToken';
let token = localStorage.getItem(TOKEN_KEY) || '';

function saveToken(t) {
  token = t;
  localStorage.setItem(TOKEN_KEY, t);
}

function headers(extra) {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function api(path, options = {}) {
  const { headers: extraHeaders, ...rest } = options;
  const res = await fetch(path, { ...rest, headers: headers(extraHeaders) });
  if (res.status === 401) {
    const t = window.prompt('This hub requires a token. Paste it (get it with: jarv-genie hub --token):');
    if (t) {
      saveToken(t.trim());
      return api(path, options);
    }
    throw new Error('unauthorized: no token provided');
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = (await res.json()).error || message;
    } catch {
      /* keep status fallback */
    }
    throw new Error(message);
  }
  return res.json();
}

async function apiStream(path, options) {
  const { headers: extraHeaders, ...rest } = options;
  const res = await fetch(path, { ...rest, headers: headers({ Accept: 'text/event-stream', ...extraHeaders }) });
  if (res.status === 401) {
    const t = window.prompt('This hub requires a token. Paste it (get it with: jarv-genie hub --token):');
    if (t) {
      saveToken(t.trim());
      return apiStream(path, options);
    }
    throw new Error('unauthorized: no token provided');
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = (await res.json()).error || message;
    } catch {
      /* keep status fallback */
    }
    throw new Error(message);
  }
  if (!res.body) return res.json();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const meta = {};
  let live = null;
  const typing = $('typing');
  if (typing) {
    const wrap = typing.closest('.msg');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.replaceChild(bubble, typing);
    live = bubble;
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let data;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (typeof data.text === 'string') {
          text += data.text;
          if (live) {
            live.textContent = text;
            scrollBottom();
          }
        } else if (data.meta) {
          Object.assign(meta, data.meta);
        } else if (data.error) {
          throw new Error(data.error);
        }
      }
    }
  }
  if (live && (meta.provider || meta.model)) {
    const m = document.createElement('div');
    m.className = 'meta';
    m.textContent = `${meta.provider || ''} / ${meta.model || ''}`.replace(/^\/\s*/, '');
    live.closest('.msg').appendChild(m);
  }
  return { text, ...meta };
}

function scrollBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function addMessage(role, text, meta) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  if (meta) {
    const m = document.createElement('div');
    m.className = 'meta';
    m.textContent = meta;
    wrap.appendChild(m);
  }
  messages.appendChild(wrap);
  scrollBottom();
  return wrap;
}

function addTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  bubble.id = 'typing';
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  scrollBottom();
}

function clearWelcome() {
  const w = messages.querySelector('.welcome');
  if (w) w.remove();
}

function setStatus(text, kind) {
  const pill = $('statusPill');
  pill.textContent = text;
  pill.className = `status${kind ? ` ${kind}` : ''}`;
}

// ---------- voice ----------
const TARGET_RATE = 16000;
const micBtn = $('micBtn');
const voiceBtn = $('voiceBtn');
let wavRec = null;
let handsFree = false;
let speakingAudio = null;
let voiceBusy = false;

function stopPlayback() {
  if (speakingAudio) {
    speakingAudio.pause();
    speakingAudio = null;
  }
}

async function apiRaw(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    body,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    const t = window.prompt('This hub requires a token. Paste it (get it with: jarv-genie hub --token):');
    if (t) {
      saveToken(t.trim());
      return apiRaw(path, body);
    }
    throw new Error('unauthorized: no token provided');
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = (await res.json()).error || message;
    } catch {
      /* keep status fallback */
    }
    throw new Error(message);
  }
  return res.json();
}

async function speakReply(text) {
  if (!text) return;
  try {
    const res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    stopPlayback();
    const url = URL.createObjectURL(blob);
    speakingAudio = new Audio(url);
    speakingAudio.onended = () => {
      URL.revokeObjectURL(url);
      speakingAudio = null;
      if (handsFree && !voiceBusy) startListening();
    };
    await speakingAudio.play();
  } catch {
    /* speaking is best-effort */
  }
}

function encodeWav16(pcm) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const wstr = (off, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length * 2, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, TARGET_RATE, true);
  dv.setUint32(28, TARGET_RATE * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, 'data');
  dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

async function createWavRecorder(onDone) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const inRate = ctx.sampleRate;
  const chunks = [];
  let heardVoice = false;
  let lastVoice = 0;
  let stopped = false;
  let maxTimer = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(maxTimer);
    proc.onaudioprocess = null;
    try { proc.disconnect(); } catch { /* noop */ }
    try { src.disconnect(); } catch { /* noop */ }
    try { gain.disconnect(); } catch { /* noop */ }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const outLen = Math.max(1, Math.floor((total * TARGET_RATE) / inRate));
    const pcm = new Int16Array(outLen);
    let srcIdx = 0;
    for (const c of chunks) {
      for (let j = 0; j < c.length; j++, srcIdx++) {
        const dst = Math.floor((srcIdx * TARGET_RATE) / inRate);
        if (dst >= outLen) break;
        pcm[dst] = Math.max(-32768, Math.min(32767, Math.round(c[j] * 32767)));
      }
    }
    onDone(encodeWav16(pcm));
  };

  proc.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    let rms = 0;
    for (let i = 0; i < data.length; i += 4) rms += data[i] * data[i];
    rms = Math.sqrt(rms / (data.length / 4));
    const now = Date.now();
    if (rms > 0.012) {
      heardVoice = true;
      lastVoice = now;
    } else if (heardVoice && now - lastVoice > 1400) {
      stop();
    }
  };
  src.connect(proc);
  proc.connect(gain);
  gain.connect(ctx.destination);

  const startTimer = setTimeout(() => stop(), 15000);
  maxTimer = startTimer;
  return { stop };
}

async function startListening() {
  if (voiceBusy || wavRec) return;
  voiceBusy = true;
  setStatus('listening… click to stop', 'mic');
  micBtn.classList.add('recording');
  try {
    wavRec = await createWavRecorder(async (blob) => {
      wavRec = null;
      micBtn.classList.remove('recording');
      setStatus('thinking…', 'mic');
      let reply = '';
      try {
        const res = await apiRaw('/api/voice/transcribe', blob);
        const text = (res.text || '').trim();
        if (!text) {
          setStatus('nothing heard', 'fail');
        } else {
          input.value = text;
          autoGrow();
          reply = (await send(true)) || '';
        }
      } catch (err) {
        setStatus('voice error', 'fail');
        addMessage('error', `Voice failed: ${err.message}`);
      } finally {
        voiceBusy = false;
        if (handsFree && reply) {
          await speakReply(reply);
        } else if (handsFree) {
          setStatus('voice on — listening…');
          startListening();
        } else {
          setStatus('idle');
        }
      }
    });
  } catch (err) {
    micBtn.classList.remove('recording');
    voiceBusy = false;
    setStatus('mic unavailable', 'fail');
    addMessage('error', `Microphone access failed: ${err.message}`);
  }
}

function bindVoice() {
  micBtn.addEventListener('click', () => {
    if (speakingAudio) stopPlayback();
    if (wavRec) {
      wavRec.stop();
      return;
    }
    if (voiceBusy) return;
    startListening();
  });
  voiceBtn.addEventListener('click', () => {
    handsFree = !handsFree;
    voiceBtn.classList.toggle('active', handsFree);
    setStatus(handsFree ? 'voice on — listening…' : 'idle');
    if (handsFree && !wavRec && !voiceBusy) startListening();
    else if (!handsFree && wavRec) wavRec.stop();
  });
}

async function send() {
  const text = input.value.trim();
  if (!text) return '';

  input.value = '';
  autoGrow();
  sendBtn.disabled = true;
  clearWelcome();

  addMessage('user', text);
  addTyping();

  try {
    const res = await apiStream('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message: text, stream: true }),
    });
    if (!res.text) {
      const typing = $('typing');
      if (typing) typing.closest('.msg').remove();
      addMessage('assistant', '(no response)');
      return '';
    }
    return res.text;
  } catch (err) {
    const typing = $('typing');
    if (typing) typing.closest('.msg').remove();
    addMessage('error', `Jarv Genie could not respond: ${err.message}`);
    return '';
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function bindComposer() {
  sendBtn.addEventListener('click', send);
  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim();
    autoGrow();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
}

function bindPanel() {
  const panel = $('panel');
  $('menuBtn').addEventListener('click', () => {
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    loadDetails();
  });
  $('panelClose').addEventListener('click', () => {
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
  });

  $('modelBtn').addEventListener('click', async () => {
    const model = $('modelInput').value.trim();
    if (!model) return;
    try {
      const res = await api('/api/model', { method: 'POST', body: JSON.stringify({ model }) });
      $('modelHint').textContent = `Now using: ${res.model}`;
      refreshStatus();
    } catch (err) {
      $('modelHint').textContent = `Failed: ${err.message}`;
    }
  });
}

function bindNew() {
  $('newBtn').addEventListener('click', async () => {
    await api('/api/new', { method: 'POST' });
    messages.querySelectorAll('.msg').forEach((n) => n.remove());
    renderWelcome();
  });
}

function renderWelcome() {
  const existing = messages.querySelector('.welcome');
  if (existing) return;
  const w = document.createElement('div');
  w.className = 'welcome';
  w.innerHTML =
    '<div class="welcome-title">Jarv Genie</div>' +
    '<div class="welcome-sub" id="welcomeSub">Local-first personal assistant</div>';
  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const idea of ['What can you do?', 'Remember my name is Alex', 'Write a to-do for today']) {
    const c = document.createElement('button');
    c.className = 'chip';
    c.textContent = idea;
    c.addEventListener('click', () => {
      input.value = idea;
      sendBtn.disabled = false;
      send();
    });
    chips.appendChild(c);
  }
  w.appendChild(chips);
  messages.prepend(w);
}

async function refreshStatus() {
  try {
    const s = await api('/api/status');
    setStatus(s.providers.join('  ·  ') || 'no providers', s.providers.length ? 'ok' : 'fail');
  } catch (err) {
    setStatus('offline', 'fail');
  }
}

async function loadDetails() {
  try {
    const s = await api('/api/status');
    $('modelInput').value = s.model;
    $('modelHint').textContent = `${s.providers.join(' · ') || 'no providers'} — v${s.version}`;
    $('memoryLine').textContent = `${s.facts} fact${s.facts === 1 ? '' : 's'} remembered`;

    const list = $('statusList');
    list.innerHTML = '';
    for (const p of s.providers) {
      const li = document.createElement('li');
      li.innerHTML = `<b>${escapeHtml(p)}</b>`;
      list.appendChild(li);
    }
    for (const err of s.externalErrors || []) {
      const li = document.createElement('li');
      li.innerHTML = `external MCP failed: ${escapeHtml(err)}`;
      list.appendChild(li);
    }

    const tools = $('toolList');
    tools.innerHTML = '';
    for (const t of s.tools) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = t;
      tools.appendChild(c);
    }
  } catch (err) {
    $('memoryLine').textContent = `Could not load details: ${err.message}`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function loadSession() {
  try {
    const msgs = await api('/api/session');
    if (msgs.length === 0) {
      renderWelcome();
      return;
    }
    for (const m of msgs) addMessage(m.role, m.content);
  } catch {
    renderWelcome();
  }
}

async function init() {
  bindComposer();
  bindPanel();
  bindNew();
  bindVoice();
  await loadSession();
  await refreshStatus();
  input.focus();
}

init();
