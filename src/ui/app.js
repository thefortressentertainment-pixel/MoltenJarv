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

async function send() {
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  autoGrow();
  sendBtn.disabled = true;
  clearWelcome();

  addMessage('user', text);
  addTyping();

  try {
    const res = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message: text }),
    });
    const typing = $('typing');
    if (typing) typing.closest('.msg').remove();
    addMessage('assistant', res.text || '(no response)', `${res.provider} / ${res.model}`);
  } catch (err) {
    const typing = $('typing');
    if (typing) typing.closest('.msg').remove();
    addMessage('error', `Jarv Genie could not respond: ${err.message}`);
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
  await loadSession();
  await refreshStatus();
  input.focus();
}

init();
