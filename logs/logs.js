// logs/logs.js — LLM call log viewer

let allEntries = [];
const filters = { REQUEST: true, RESPONSE: true, ERROR: true };

// ── Bootstrap ─────────────────────────────────────────────────────────────

function init() {
  document.getElementById('refreshBtn').addEventListener('click', loadLogs);
  document.getElementById('exportBtn').addEventListener('click', exportLogs);
  document.getElementById('clearBtn').addEventListener('click', clearLogs);
  document.getElementById('showReq').addEventListener('change',  e => { filters.REQUEST  = e.target.checked; render(); });
  document.getElementById('showResp').addEventListener('change', e => { filters.RESPONSE = e.target.checked; render(); });
  document.getElementById('showErr').addEventListener('change',  e => { filters.ERROR    = e.target.checked; render(); });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type !== 'LLM_LOG') return;
    allEntries.unshift(msg.entry);
    if (allEntries.length > 200) allEntries.length = 200;
    render();
  });

  loadLogs();
}

async function loadLogs() {
  const { llmLogs = [] } = await chrome.storage.local.get('llmLogs');
  allEntries = llmLogs;
  render();
}

function exportLogs() {
  const json = JSON.stringify(allEntries, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `busybot-llm-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function clearLogs() {
  await chrome.storage.local.set({ llmLogs: [] });
  allEntries = [];
  render();
}

// ── Render ────────────────────────────────────────────────────────────────

function render() {
  const list    = document.getElementById('logList');
  const visible = allEntries.filter(e => filters[e.direction] ?? true);

  document.getElementById('count').textContent =
    `${visible.length} entr${visible.length === 1 ? 'y' : 'ies'}`;

  if (visible.length === 0) {
    list.innerHTML = '<div class="empty">No LLM calls recorded yet. Enable the bot and trigger a message.</div>';
    return;
  }

  list.innerHTML = '';
  visible.forEach(e => list.appendChild(buildEntry(e)));
}

// ── Entry card ────────────────────────────────────────────────────────────

function buildEntry(entry) {
  const el  = document.createElement('div');
  el.className = 'entry';

  const dir = entry.direction ?? 'UNKNOWN';
  const ts  = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '—';

  let summary = '';
  let tokens  = '';

  if (dir === 'REQUEST') {
    const forcing = Array.isArray(entry.forcing) ? entry.forcing.join(', ') : String(entry.forcing ?? '—');
    summary = `forcing: ${forcing} · ${entry.messages?.length ?? 0} turns`;
  } else if (dir === 'RESPONSE') {
    const fns = entry.functionCalls?.length ? entry.functionCalls.join(', ') : 'text';
    summary = `${entry.finishReason ?? ''} · ${fns}`;
    if (entry.usage) tokens = `${entry.usage.totalTokens} tok`;
  } else if (dir === 'ERROR') {
    summary = `HTTP ${entry.status ?? '—'}`;
  }

  el.innerHTML = `
    <div class="entry-header">
      <span class="dir-badge dir-${dir}">${dir}</span>
      <span class="entry-ts">${ts}</span>
      <span class="entry-summary">${escHtml(summary)}</span>
      ${tokens ? `<span class="entry-tokens">${escHtml(tokens)}</span>` : ''}
      <span class="chevron">›</span>
    </div>
    <div class="entry-body"></div>
  `;

  el.querySelector('.entry-body').appendChild(buildBodyEl(entry));
  el.querySelector('.entry-header').addEventListener('click', () => el.classList.toggle('open'));
  return el;
}

// ── Entry body (expanded detail) ──────────────────────────────────────────

function buildBodyEl(entry) {
  const frag = document.createDocumentFragment();
  const dir  = entry.direction;

  if (dir === 'REQUEST') {
    const forcing = Array.isArray(entry.forcing) ? entry.forcing.join(', ') : String(entry.forcing ?? '—');
    frag.append(
      sectionLabel('Model · Forcing'),
      kvGrid([
        ['model',   entry.model ?? '—', ''],
        ['forcing', forcing,            'highlight']
      ])
    );

    const msgs = entry.messages ?? [];
    if (msgs.length) {
      frag.append(sectionLabel(`Messages (${msgs.length} turns)`));
      msgs.forEach(m => frag.append(buildMsgRow(m)));
    }

  } else if (dir === 'RESPONSE') {
    const fns = entry.functionCalls?.join(', ') || 'none';
    frag.append(
      sectionLabel('Result'),
      kvGrid([
        ['finishReason', entry.finishReason ?? '—', ''],
        ['fnCalls',      fns,                        'highlight'],
        ...(entry.textSnippet ? [['text', entry.textSnippet, '']] : [])
      ])
    );

    if (entry.usage) {
      frag.append(
        sectionLabel('Token Usage'),
        kvGrid([
          ['prompt', String(entry.usage.promptTokens),    ''],
          ['output', String(entry.usage.candidateTokens), ''],
          ['total',  String(entry.usage.totalTokens),     'highlight']
        ])
      );
    }

  } else if (dir === 'ERROR') {
    frag.append(
      sectionLabel('Error'),
      kvGrid([
        ['status', String(entry.status ?? '—'), 'error'],
        ['body',   entry.body ?? '—',           'error']
      ])
    );
  }

  return frag;
}

function buildMsgRow(m) {
  const row = document.createElement('div');
  row.className = `msg-row ${m.role === 'model' ? 'model' : 'user'}`;

  const roleEl  = document.createElement('span');
  roleEl.className = 'msg-role';
  roleEl.textContent = m.role;

  const partsEl = document.createElement('span');
  partsEl.className = 'msg-parts';

  (m.parts ?? []).forEach(p => {
    const d = document.createElement('div');
    d.className = 'part';
    if (p.type === 'text') {
      d.classList.add('text');
      d.textContent = `📝 ${p.text}`;
    } else if (p.type === 'functionCall') {
      d.classList.add('fnCall');
      d.textContent = `⚙️ ${p.name}(${JSON.stringify(p.args)})`;
    } else if (p.type === 'functionResponse') {
      d.classList.add('fnResp');
      d.textContent = `↩ ${p.name}`;
    } else {
      d.classList.add('text');
      d.textContent = JSON.stringify(p);
    }
    partsEl.appendChild(d);
  });

  row.append(roleEl, partsEl);
  return row;
}

// ── DOM helpers ───────────────────────────────────────────────────────────

function sectionLabel(text) {
  const el = document.createElement('div');
  el.className = 'section-label';
  el.textContent = text;
  return el;
}

function kvGrid(pairs) {
  const grid = document.createElement('div');
  grid.className = 'kv-grid';
  pairs.forEach(([key, val, cls]) => {
    const k = document.createElement('span');
    k.className = 'kv-key';
    k.textContent = key;

    const v = document.createElement('span');
    v.className = `kv-val${cls ? ' ' + cls : ''}`;
    v.textContent = val;

    grid.append(k, v);
  });
  return grid;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Start ─────────────────────────────────────────────────────────────────

init();
