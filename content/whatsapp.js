// content/whatsapp.js — WhatsApp Web watcher (Manifest V3)
// Watches BOTH: sidebar unread badges + active/open conversation new messages

const PLATFORM = 'whatsapp';
const seenIds   = new Set();
let initialized = false;
let sidebarObserver      = null;
let conversationObserver = null;

// ─────────────────────── Bootstrap ───────────────────────────────────────

function init() {
  if (initialized) return;
  initialized = true;

  chrome.runtime.sendMessage({ type: 'TAB_READY', platform: PLATFORM }).catch(() => {});
  console.log('[BusyBot/WA] Content script loaded — setting up observers');

  // WhatsApp is a SPA. #main appears only after a chat is opened.
  // Watch #app (or body) with subtree:false to detect when #main is added,
  // then wire the conversation observer onto it.
  const appRoot = document.querySelector('#app') ?? document.body;
  const appObserver = new MutationObserver(debounce(setupObservers, 800));
  appObserver.observe(appRoot, { childList: true, subtree: true });

  setupObservers();
  // Retry while WhatsApp is still loading its panels
  setTimeout(setupObservers, 2000);
  setTimeout(setupObservers, 5000);
  setTimeout(setupObservers, 9000);

  // Safety-net poll: catches any messages the mutation observer may have missed
  setInterval(scanActiveConversation, 10000);
}

function setupObservers() {
  // 1. Sidebar — unread badges for chats NOT currently open
  const sidebar = document.querySelector('#pane-side');
  if (sidebar && !sidebarObserver) {
    sidebarObserver = new MutationObserver(debounce(scanSidebarUnread, 800));
    sidebarObserver.observe(sidebar, { childList: true, subtree: true });
    console.log('[BusyBot/WA] Sidebar observer attached');
  }

  // 2. Active conversation — new messages in the CURRENTLY OPEN chat.
  // WhatsApp marks messages read immediately so there may be no sidebar badge;
  // this is the primary detection path.
  const main = document.querySelector('#main');
  if (main) {
    if (conversationObserver) conversationObserver.disconnect();
    conversationObserver = new MutationObserver(debounce(scanActiveConversation, 300));
    conversationObserver.observe(main, { childList: true, subtree: true });
    console.log('[BusyBot/WA] Active-conversation observer attached');
  }
}

// ─────────────────────── Sidebar unread scan ─────────────────────────────

function scanSidebarUnread() {
  const cells = document.querySelectorAll(
    '#pane-side [data-testid="cell-frame-container"], ' +
    '#pane-side [role="row"], ' +
    '#pane-side [role="listitem"]'
  );

  cells.forEach(cell => {
    const badge = cell.querySelector(
      '[data-testid="icon-unread-count"], ' +
      'span[aria-label*="unread" i], ' +
      '.unread-count, [class*="unread"]'
    );
    if (!badge) return;
    const badgeNum = parseInt(badge.textContent?.trim(), 10);
    if (!badgeNum || isNaN(badgeNum) || badgeNum === 0) return;

    const sender = getSenderFromCell(cell);
    if (!sender) return;

    const previewEl =
      cell.querySelector('[data-testid="cell-frame-secondary"] span[dir="ltr"] span') ||
      cell.querySelector('[data-testid="cell-frame-secondary"] span[dir="ltr"]')       ||
      cell.querySelector('[data-testid="cell-frame-secondary"] span:not([class*="icon"])') ||
      cell.querySelector('[data-testid="cell-frame-secondary"]');

    const rawText = previewEl?.textContent?.trim() ?? '';
    const text = rawText.replace(/^[\s\u200e\u200f]+/, '').trim() || 'New message';

    reportMessage(sender, text, `sidebar|${sender}|${badgeNum}`);
  });
}

function getSenderFromCell(cell) {
  const el = cell.querySelector(
    '[data-testid="cell-frame-title"] span[title], ' +
    '[data-testid="cell-frame-title"] span, ' +
    'span[title][dir="auto"]'
  );
  return el?.getAttribute('title') || el?.textContent?.trim() || null;
}

// ─────────────────────── Active-conversation scan ─────────────────────────

function scanActiveConversation() {
  const sender = getActiveSender();
  if (!sender) return;

  const incoming = document.querySelectorAll(
    '.message-in, ' +
    '[data-testid="msg-container"][class*="in"], ' +
    '[class*="focusable-list-item"] [class*="message-in"]'
  );
  if (incoming.length === 0) return;

  const last = incoming[incoming.length - 1];

  // Only act on messages received within the last 10 minutes.
  if (!isMessageRecent(last, 10)) return;

  const textEl = last.querySelector(
    'span.selectable-text.copyable-text, ' +
    'span[class*="selectable-text"], ' +
    'span[dir="ltr"]'
  );
  const text = textEl?.textContent?.trim() || '';
  if (!text) return;

  const msgId  = last.closest('[data-id]')?.getAttribute('data-id');
  const msgKey = msgId ? `id|${msgId}` : `active|${sender}|${text.slice(0, 50)}`;

  reportMessage(sender, text, msgKey);
}

// ─────────────────────── Recency check ───────────────────────────────────
// Parses data-pre-plain-text from the message bubble.
// WhatsApp formats (varies by locale):
//   24h day-first:  "[16:47, 20/4/2026] Name: "
//   12h US:         "[4:47 PM, 4/20/2026] Name: "
// Falls back to true (assume recent) if the attribute is missing or unparseable,
// so we never silently drop messages.

function isMessageRecent(msgEl, maxAgeMinutes) {
  const copyable = msgEl.querySelector('[data-pre-plain-text]');
  if (!copyable) return true;

  const meta = copyable.getAttribute('data-pre-plain-text') ?? '';

  // Match both 24h and 12h (optional AM/PM) formats
  const m = meta.match(
    /\[(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?,\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\]/
  );
  if (!m) return true;

  let [, hhStr, mmStr, ampm] = m;
  let hour = parseInt(hhStr, 10);
  const min = parseInt(mmStr, 10);

  if (ampm) {
    const ap = ampm.toUpperCase();
    if (ap === 'PM' && hour < 12) hour += 12;
    if (ap === 'AM' && hour === 12) hour = 0;
  }

  // Compare only hour+minute to avoid day/month ambiguity across locales.
  // Messages are assumed to be from today (WhatsApp shows "today" for same-day).
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const msgMins = hour * 60 + min;
  let diff = nowMins - msgMins;
  if (diff < 0) diff += 24 * 60; // handle midnight rollover

  return diff <= maxAgeMinutes;
}

// ─────────────────────── Active sender detection ─────────────────────────
// WhatsApp's header contains both the contact name span AND status texts
// ("online", "last seen…", "click here for contact info", "typing…").
// Both match generic selectors, so we explicitly reject known status texts.
// As a final fallback, extract the sender from the last message's metadata.

const WA_STATUS_PATTERNS = [
  /^online$/i,
  /^last seen/i,
  /^click here for contact info$/i,
  /^typing\.\.\./i,
  /^recording\.\.\./i,
];

function isValidSenderName(name) {
  if (!name || name.length < 2) return false;
  return !WA_STATUS_PATTERNS.some(re => re.test(name.trim()));
}

function getActiveSender() {
  // 1. Most specific: WhatsApp's data-testid on the title container
  const titleEl = document.querySelector(
    '[data-testid="conversation-info-header-chat-title"] span[title], ' +
    '[data-testid="conversation-info-header-chat-title"] span'
  );
  if (titleEl) {
    const name = titleEl.getAttribute('title') || titleEl.textContent?.trim();
    if (name && isValidSenderName(name)) return name;
  }

  // 2. Iterate all header spans and return the first valid one
  const candidates = document.querySelectorAll(
    '#main header span[dir="auto"][title], #main header span[title]'
  );
  for (const el of candidates) {
    const name = el.getAttribute('title') || el.textContent?.trim();
    if (name && isValidSenderName(name)) return name;
  }

  // 3. Extract from the last incoming message's data-pre-plain-text.
  // Format: "[16:47, 20/4/2026] Ramesh usa. 2025: " — name is after "] " and before ": "
  const lastMsgMeta = document.querySelector('.message-in [data-pre-plain-text]');
  if (lastMsgMeta) {
    const meta = lastMsgMeta.getAttribute('data-pre-plain-text') ?? '';
    const nameMatch = meta.match(/\]\s+(.+?):\s*$/);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      if (isValidSenderName(name)) return name;
    }
  }

  return null;
}

// ─────────────────────── Dedup + report ──────────────────────────────────

function reportMessage(sender, text, dedupKey) {
  if (seenIds.has(dedupKey)) return;
  seenIds.add(dedupKey);

  if (seenIds.size > 300) {
    const arr = [...seenIds];
    arr.splice(0, 150).forEach(k => seenIds.delete(k));
  }

  console.log(`[BusyBot/WA] New message — from: ${sender} | text: ${text}`);

  chrome.runtime.sendMessage({
    type: 'NEW_MESSAGE',
    platform: PLATFORM,
    sender,
    text,
    chatId: sender
  }).catch(() => {});
}

// ─────────────────────── Reply sender ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'SEND_REPLY' || msg.platform !== PLATFORM) return;

  console.log(`[BusyBot/WA] Sending reply to ${msg.sender}: "${msg.text}"`);

  injectReply(msg.sender, msg.text)
    .then(success => {
      console.log(`[BusyBot/WA] Reply ${success ? 'sent ✅' : 'failed ❌'}`);
      sendResponse({ success });
    })
    .catch(err => {
      console.error('[BusyBot/WA] injectReply error:', err.message);
      sendResponse({ success: false, error: err.message });
    });

  return true;
});

async function injectReply(sender, text) {
  const activeName = getActiveSender() ?? '';

  if (!activeName || !activeName.includes(sender)) {
    const cells = document.querySelectorAll(
      '#pane-side [data-testid="cell-frame-container"], ' +
      '#pane-side [role="row"], ' +
      '#pane-side [role="listitem"]'
    );
    let target = null;
    for (const cell of cells) {
      const name = getSenderFromCell(cell);
      if (name && (name === sender || name.includes(sender))) {
        target = cell;
        break;
      }
    }
    if (!target) throw new Error(`Chat not found for: ${sender}`);
    target.click();
    await sleep(700);
  }

  const input = await waitForElement(
    '[data-testid="conversation-compose-box-input"], ' +
    'div[contenteditable="true"][data-tab="10"], ' +
    'footer div[contenteditable="true"]',
    3000
  );
  if (!input) throw new Error('Compose box not found');

  input.focus();
  await sleep(100);

  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));

  await sleep(250);

  const sendBtn = await waitForElement(
    '[data-testid="send"], button[aria-label="Send"], span[data-icon="send"]',
    2000
  );

  if (sendBtn) {
    (sendBtn.closest('button') ?? sendBtn).click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
  }

  await sleep(250);

  // Prevent re-replying to our own outgoing message
  seenIds.add(`active|${sender}|${text.slice(0, 50)}`);

  return true;
}

// ─────────────────────── Utilities ───────────────────────────────────────

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForElement(selector, timeoutMs) {
  const el = document.querySelector(selector);
  if (el) return el;
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const iv = setInterval(() => {
      const found = document.querySelector(selector);
      if (found || Date.now() > deadline) {
        clearInterval(iv);
        resolve(found ?? null);
      }
    }, 150);
  });
}

// ─────────────────────── Start ────────────────────────────────────────────

if (document.readyState === 'complete') {
  setTimeout(init, 2500);
} else {
  window.addEventListener('load', () => setTimeout(init, 2500));
}
