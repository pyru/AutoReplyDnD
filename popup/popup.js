// popup/popup.js — Popup controller with live reasoning chain & reply log

// ── Step appearance config ────────────────────────────────────────────────

const STEP_ICONS = {
  done:    '✅',
  stopped: '🛑',
  running: '🔄',
  failed:  '❌',
  summary: '🧠',
  error:   '❌',
  default: '⚪'
};

const STEP_ARROWS = {
  done:    '→ Proceeding…',
  stopped: '→ Stopped',
  running: '→ Processing…',
  failed:  '→ Failed',
  summary: '',
  error:   ''
};

const PLATFORM_ICONS = { whatsapp: '📱', telegram: '✈️' };

// ── State ─────────────────────────────────────────────────────────────────

let state = {
  enabled: false,
  replyLog: [],
  reasoningChain: [],
  hasApiKey: false,
  isAgentRunning: false
};

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function init() {
  const fresh = await chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch(() => null);
  if (fresh) applyState(fresh);

  // Live updates from background service worker
  chrome.runtime.onMessage.addListener(onBackgroundMessage);

  document.getElementById('toggleBtn').addEventListener('click', onToggle);
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('logsBtn').addEventListener('click', openLogs);
  document.getElementById('clearBtn').addEventListener('click', onClear);
}

function onBackgroundMessage(msg) {
  switch (msg.type) {
    case 'STATE_CHANGE':
      applyState({ enabled: msg.enabled });
      break;

    case 'AGENT_STARTED':
      applyState({ isAgentRunning: true });
      setStatus(`Processing message from ${msg.sender} (${msg.platform})…`);
      renderChain([]);  // clear chain for new run
      break;

    case 'REASONING_UPDATE':
      applyState({ isAgentRunning: msg.chain.some(s => s.status === 'running'), reasoningChain: msg.chain });
      renderChain(msg.chain);
      break;

    case 'AGENT_DONE':
      applyState({ isAgentRunning: false });
      break;

    case 'REPLY_LOGGED':
      prependLogEntry(msg.entry);
      break;

    case 'LOG_CLEARED':
      applyState({ replyLog: [], reasoningChain: [] });
      renderChain([]);
      renderLog([]);
      break;
  }
}

// ── State management ──────────────────────────────────────────────────────

function applyState(partial) {
  state = { ...state, ...partial };
  renderHeader();
}

function renderHeader() {
  const btn   = document.getElementById('toggleBtn');
  const dot   = document.getElementById('toggleDot');
  const label = document.getElementById('toggleLabel');
  const badge = document.getElementById('agentBadge');

  if (state.enabled) {
    btn.classList.add('on');
    dot.textContent   = '🟢';
    label.textContent = 'Auto-Reply ON';
  } else {
    btn.classList.remove('on');
    dot.textContent   = '⚪';
    label.textContent = 'Auto-Reply OFF';
  }

  badge.classList.toggle('hidden', !state.isAgentRunning);

  if (!state.hasApiKey) {
    setStatus('⚠️ No API key — open Settings to configure');
  } else if (state.isAgentRunning) {
    // status already set by AGENT_STARTED
  } else if (state.enabled) {
    setStatus('Monitoring WhatsApp Web & Telegram Web');
  } else {
    setStatus('Auto-reply disabled');
  }
}

function setStatus(text) {
  document.getElementById('statusText').textContent = text;
}

// ── Render: Reasoning Chain ───────────────────────────────────────────────

function renderChain(chain) {
  const container = document.getElementById('chain');

  if (!chain || chain.length === 0) {
    container.innerHTML = '<p class="empty">Enable the bot, then open WhatsApp Web or Telegram Web to see the agent in action.</p>';
    return;
  }

  container.innerHTML = '';
  chain.forEach(step => container.appendChild(buildStepEl(step)));

  // Scroll to latest step
  container.scrollTop = container.scrollHeight;
}

function buildStepEl(step) {
  const el = document.createElement('div');
  el.className = `step ${step.status ?? 'default'}`;

  const icon   = STEP_ICONS[step.status]  ?? STEP_ICONS.default;
  const arrow  = STEP_ARROWS[step.status] ?? '';
  const detail = step.detail ?? '';

  el.innerHTML = `
    <div class="step-head">
      <span class="step-icon">${icon}</span>
      <span class="step-title">${escHtml(step.title)}</span>
    </div>
    <div class="step-body">${escHtml(detail)}</div>
    ${arrow ? `<div class="step-arrow">${arrow}</div>` : ''}
  `;
  return el;
}

// ── Render: Reply Log ─────────────────────────────────────────────────────

function renderLog(entries) {
  const container = document.getElementById('log');
  if (!entries || entries.length === 0) {
    container.innerHTML = '<p class="empty">No replies sent yet.</p>';
    return;
  }
  container.innerHTML = '';
  entries.slice(0, 25).forEach(e => container.appendChild(buildLogEl(e)));
}

function prependLogEntry(entry) {
  const container = document.getElementById('log');
  const empty = container.querySelector('.empty');
  if (empty) empty.remove();

  const el = buildLogEl(entry);
  container.insertBefore(el, container.firstChild);
}

function buildLogEl(entry) {
  const el   = document.createElement('div');
  el.className = 'log-entry';
  const icon = PLATFORM_ICONS[entry.platform] ?? '💬';
  el.innerHTML = `
    <span class="log-time">${escHtml(entry.time)}</span>
    <span class="log-sender">${escHtml(entry.sender)}</span>
    <span class="log-plat">(${icon} ${escHtml(entry.platform)})</span>
    <span class="log-tick">✅</span>
  `;
  return el;
}

// ── Event Handlers ────────────────────────────────────────────────────────

async function onToggle() {
  const newVal = !state.enabled;
  applyState({ enabled: newVal });
  await chrome.runtime.sendMessage({ type: 'TOGGLE_ENABLED', enabled: newVal });
}

function openSettings() {
  chrome.runtime.openOptionsPage();
}

function openLogs() {
  chrome.tabs.create({ url: chrome.runtime.getURL('logs/logs.html') });
}

async function onClear() {
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOG' });
}

// ── Full state render (called once on load) ───────────────────────────────

function fullRender() {
  renderHeader();
  if (state.reasoningChain?.length) renderChain(state.reasoningChain);
  if (state.replyLog?.length)       renderLog(state.replyLog);
}

// ── Utility ───────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Start ─────────────────────────────────────────────────────────────────

init().then(fullRender);
