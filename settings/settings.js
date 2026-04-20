// settings/settings.js — Gemini edition

const $ = id => document.getElementById(id);

// Default key from .env (via config.js) — shown as placeholder when no override stored
const DEFAULT_GEMINI_KEY   = 'AIzaSyDfg5-g71EnMWtXNS6dZyDmwIHgSfXnUmM';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';

// ── Load saved settings ───────────────────────────────────────────────────

async function loadSettings() {
  const data = await chrome.storage.local.get([
    'geminiApiKey', 'dndStart', 'dndEnd', 'customTemplate', 'maxRepliesPerDay'
  ]);

  $('apiKey').value = data.geminiApiKey || DEFAULT_GEMINI_KEY;
  if (data.dndStart)       $('dndStart').value       = data.dndStart;
  if (data.dndEnd)         $('dndEnd').value         = data.dndEnd;
  if (data.customTemplate) $('customTemplate').value = data.customTemplate;

  const max = data.maxRepliesPerDay ?? 10;
  $('maxReplies').value          = max;
  $('maxRepliesDisplay').textContent = max;

  updateApiStatus($('apiKey').value);
  updateDndPreview();
}

// ── Save ──────────────────────────────────────────────────────────────────

async function save() {
  const apiKey           = $('apiKey').value.trim();
  const dndStart         = $('dndStart').value;
  const dndEnd           = $('dndEnd').value;
  const customTemplate   = $('customTemplate').value.trim();
  const maxRepliesPerDay = parseInt($('maxReplies').value, 10) || 10;

  if (!apiKey) {
    showStatus('saveStatus', '⚠️ Gemini API key cannot be empty.', 'err');
    return;
  }

  if (!apiKey.startsWith('AIzaSy')) {
    showStatus('saveStatus', '⚠️ Gemini keys usually start with AIzaSy…', 'err');
    return;
  }

  await chrome.storage.local.set({
    geminiApiKey: apiKey, dndStart, dndEnd, customTemplate, maxRepliesPerDay
  });
  $('maxRepliesDisplay').textContent = maxRepliesPerDay;
  showStatus('saveStatus', `✅ Settings saved! Max ${maxRepliesPerDay} replies/sender/day.`, 'ok');
  updateApiStatus(apiKey);
}

// ── DnD preview ───────────────────────────────────────────────────────────

function updateDndPreview() {
  const start = $('dndStart').value || '09:00';
  const end   = $('dndEnd').value   || '18:00';
  const now   = new Date();
  const cur   = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const active  = cur >= sh * 60 + sm && cur < eh * 60 + em;
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  $('dndPreview').textContent = active
    ? `🟢 DnD is currently ACTIVE (now ${timeStr}) — auto-replies will be sent`
    : `⚪ DnD is currently INACTIVE (now ${timeStr}) — outside the ${start}–${end} window`;
}

// ── Reset reply history ───────────────────────────────────────────────────

async function resetHistory() {
  await chrome.storage.local.set({ repliedToday: {} });
  showStatus('resetStatus', '✅ Reply history cleared.', 'ok');
}

// ── API key status indicator ──────────────────────────────────────────────

function updateApiStatus(apiKey) {
  const el = $('apiStatus');
  if (!apiKey) {
    el.textContent = '';
    el.className   = 'status-msg';
  } else if (apiKey.startsWith('AIzaSy')) {
    el.textContent = `✅ Key looks valid — model: ${DEFAULT_GEMINI_MODEL}`;
    el.className   = 'status-msg ok';
  } else {
    el.textContent = '⚠️ Gemini keys typically start with AIzaSy…';
    el.className   = 'status-msg err';
  }
}

// ── Toggle key visibility ─────────────────────────────────────────────────

function toggleApiVisibility() {
  const input = $('apiKey');
  const btn   = $('toggleApiVis');
  if (input.type === 'password') {
    input.type      = 'text';
    btn.textContent = '🙈';
  } else {
    input.type      = 'password';
    btn.textContent = '👁️';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function showStatus(id, msg, type) {
  const el = $(id);
  el.textContent = msg;
  el.className   = `status-msg ${type}`;
  setTimeout(() => { el.textContent = ''; el.className = 'status-msg'; }, 3500);
}

// ── Wire events ───────────────────────────────────────────────────────────

$('saveBtn').addEventListener('click', save);
$('resetHistory').addEventListener('click', resetHistory);
$('toggleApiVis').addEventListener('click', toggleApiVisibility);
$('apiKey').addEventListener('input', () => updateApiStatus($('apiKey').value.trim()));
$('dndStart').addEventListener('change', updateDndPreview);
$('dndEnd').addEventListener('change', updateDndPreview);
$('maxReplies').addEventListener('input', () => {
  $('maxRepliesDisplay').textContent = $('maxReplies').value || '10';
});

loadSettings();
