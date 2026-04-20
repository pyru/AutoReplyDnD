// content/telegram.js — DOM watcher for Telegram Web (web.telegram.org/k/)

const PLATFORM = 'telegram';
const seenIds   = new Set();
let initialized = false;
let sidebarObserver     = null;
let conversationObserver = null;

// ─────────────────────── Bootstrap ───────────────────────────────────────

function init() {
  if (initialized) return;
  initialized = true;

  chrome.runtime.sendMessage({ type: 'TAB_READY', platform: PLATFORM }).catch(() => {});
  console.log('[BusyBot/TG] Content script loaded — setting up observers');

  // Re-wire observers when Telegram navigates between chats (SPA).
  // Use subtree:true so we detect when #column-center appears after a chat is opened.
  const appRoot = document.querySelector('#app') ?? document.body;
  const appObserver = new MutationObserver(debounce(setupObservers, 800));
  appObserver.observe(appRoot, { childList: true, subtree: true });

  setupObservers();
  setTimeout(setupObservers, 2000);
  setTimeout(setupObservers, 5000);
  setTimeout(setupObservers, 9000);

  // Safety-net poll: catches messages the mutation observer may have missed
  setInterval(scanActiveConversation, 10000);
}

function setupObservers() {
  // 1. Sidebar — catches unread badges for chats NOT currently open
  const sidebar = document.querySelector(
    '#column-left, .chatlist, .sidebar-left-section'
  );
  if (sidebar && !sidebarObserver) {
    sidebarObserver = new MutationObserver(debounce(scanSidebarUnread, 500));
    sidebarObserver.observe(sidebar, { childList: true, subtree: true });
    console.log('[BusyBot/TG] Sidebar observer attached');
  }

  // 2. Active conversation — catches messages in the CURRENTLY OPEN chat
  // Telegram K marks the open chat read immediately (no sidebar badge),
  // so this path handles the most common case.
  const main = document.querySelector('#column-center, .chat, .bubbles');
  if (main) {
    if (conversationObserver) conversationObserver.disconnect();
    conversationObserver = new MutationObserver(debounce(scanActiveConversation, 300));
    conversationObserver.observe(main, { childList: true, subtree: true });
    console.log('[BusyBot/TG] Active-conversation observer attached');
  }
}

// ─────────────────────── Sidebar unread scan ─────────────────────────────

function scanSidebarUnread() {
  const chatItems = document.querySelectorAll(
    '.chatlist-chat, .chat-item-wrapper, [data-peer-id], ' +
    '.chat-item, .rp.chatlist-chat-container'
  );

  chatItems.forEach(item => {
    const badge = item.querySelector(
      '.badge, .chat-unread, [class*="unread"], .unread-count, div.badge-chip'
    );
    if (!badge) return;

    const badgeText = badge.textContent?.trim();
    if (!badgeText || badgeText === '0') return;

    const nameEl = item.querySelector(
      '.peer-title, .dialog-title, .chat-title, ' +
      '[class*="title"]:not(.badge):not([class*="status"])'
    );
    const sender = nameEl?.textContent?.trim() || '';
    if (!sender) return;

    const previewEl = item.querySelector(
      '.message, .last-message, [class*="message-text"], [class*="last-msg"], .chat-message'
    );
    const text = previewEl?.textContent?.trim() || 'New message';

    reportMessage(sender, text, `tg-sidebar|${sender}|${badgeText}|${text.slice(0, 30)}`);
  });
}

// ─────────────────────── Active-conversation scan ─────────────────────────
// Handles messages in the chat that is CURRENTLY OPEN in Telegram K.
// Telegram marks the active chat as read immediately, so there will be
// no sidebar badge — this is the primary detection path.

function scanActiveConversation() {
  // Get sender from Telegram K's top bar
  const header = document.querySelector(
    '.chat-info .peer-title, .top-bar .peer-title, ' +
    '#column-center .info .peer-title, .chat-info-container .peer-title, ' +
    '.chat .info .peer-title'
  );
  if (!header) return;
  const sender = header.textContent?.trim();
  if (!sender) return;

  // Incoming message bubbles: .bubble without .out (outgoing) or .service (date headers etc.)
  const bubbles = document.querySelectorAll(
    '.bubble:not(.out):not(.service):not(.is-group-last), ' +
    '.message:not(.out)'
  );
  // Also try without the is-group-last exclusion as a broader fallback
  const all = bubbles.length
    ? bubbles
    : document.querySelectorAll('.bubble:not(.out):not(.service)');

  if (!all.length) return;

  const last = all[all.length - 1];

  // Only process recent messages (within last 5 minutes) using data-timestamp
  // Telegram K stores Unix timestamp (seconds) on the bubble element
  const tsAttr = last.getAttribute('data-timestamp') ??
    last.closest('[data-timestamp]')?.getAttribute('data-timestamp');
  if (tsAttr) {
    const msgMs = parseInt(tsAttr, 10) * 1000;
    if (Date.now() - msgMs > 5 * 60 * 1000) return; // older than 5 min
  }

  // Extract text — Telegram K uses .message > p or .translatable-message
  const textEl = last.querySelector(
    '.message p, .translatable-message, .message:not(.time)'
  );
  const text = textEl?.textContent?.trim() || '';
  if (!text) return; // skip media/sticker bubbles with no text

  // Use data-mid (message ID) for stable dedup; fall back to text-based key
  const mid    = last.getAttribute('data-mid') ?? last.closest('[data-mid]')?.getAttribute('data-mid');
  const msgKey = mid ? `tg-active|${mid}` : `tg-active|${sender}|${text.slice(0, 50)}`;

  reportMessage(sender, text, msgKey);
}

// ─────────────────────── Dedup + report ──────────────────────────────────

function reportMessage(sender, text, dedupKey) {
  if (seenIds.has(dedupKey)) return;
  seenIds.add(dedupKey);

  if (seenIds.size > 300) {
    const arr = [...seenIds];
    arr.splice(0, 150).forEach(k => seenIds.delete(k));
  }

  console.log(`[BusyBot/TG] New message — from: ${sender} | text: ${text}`);

  chrome.runtime.sendMessage({
    type: 'NEW_MESSAGE',
    platform: PLATFORM,
    sender,
    text,
    chatId: sender
  }).catch(() => {});
}

// ─────────────────────── Reply Sender ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'SEND_REPLY' || msg.platform !== PLATFORM) return;

  console.log(`[BusyBot/TG] Sending reply to ${msg.sender}: "${msg.text}"`);

  injectReply(msg.sender, msg.text)
    .then(success => {
      console.log(`[BusyBot/TG] Reply ${success ? 'sent ✅' : 'failed ❌'}`);
      sendResponse({ success });
    })
    .catch(err => {
      console.error('[BusyBot/TG] injectReply error:', err.message);
      sendResponse({ success: false, error: err.message });
    });

  return true;
});

async function injectReply(sender, text) {
  // ── 1. Navigate to the chat if it isn't already open ─────────────────────
  // Telegram K's compact sidebar shows only avatar circles — the chat IS
  // still in the DOM with .peer-title, but we check the active chat first
  // to avoid an unnecessary click.
  const activeTitle = document.querySelector(
    '.chat-info .peer-title, .top-bar .peer-title, ' +
    '#column-center .info .peer-title, .chat-info-container .peer-title, ' +
    '.chat .info .peer-title'
  );
  const activeName = activeTitle?.textContent?.trim() ?? '';

  if (!activeName || !normIncludes(activeName, sender)) {
    // Search the sidebar chat list (even in compact/avatar-only mode the
    // .peer-title elements remain in the DOM, just not visually expanded)
    const chatItems = document.querySelectorAll(
      '.chatlist-chat, .chat-item-wrapper, [data-peer-id], .chat-item, ' +
      '.rp.chatlist-chat-container, .chat-item-wrapper.chatlist-chat'
    );

    let target = null;
    for (const item of chatItems) {
      const nameEl = item.querySelector(
        '.peer-title, .dialog-title, .chat-title, ' +
        '[class*="title"]:not(.badge):not([class*="status"]):not([class*="icon"])'
      );
      const name = nameEl?.textContent?.trim() ?? '';
      if (name && normIncludes(name, sender)) {
        target = item;
        break;
      }
    }

    if (!target) throw new Error(`Chat not found for sender: ${sender}`);
    target.click();
    await sleep(1000); // Telegram K needs ~1 s to render the conversation panel
  }

  // ── 2. Wait for the compose box ───────────────────────────────────────────
  const input = await waitForElement(
    '#editable-message-text, ' +
    '.input-message-input[contenteditable="true"], ' +
    '[contenteditable="true"].input-message-input, ' +
    'div[contenteditable="true"][data-placeholder]',
    3000
  );
  if (!input) throw new Error('Telegram compose box not found');

  input.focus();
  await sleep(50);

  // ── 3. Inject text ────────────────────────────────────────────────────────
  // Always clear first so fallback methods can't append to a partial insert.
  input.innerHTML = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(50);

  // Primary: clipboard paste — most compatible with Telegram K's event model
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  await sleep(150);

  if (!input.innerText.trim()) {
    // Fallback: direct set + input event
    input.textContent = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
  }

  // ── 4. Send ───────────────────────────────────────────────────────────────
  const sendBtn = await waitForElement(
    '.btn-send, .send-button, button.c-btn-send, [class*="send-btn"]',
    2000
  );

  if (sendBtn) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
  }

  await sleep(300);

  // Mark this reply as seen so we don't auto-reply to our own outgoing message
  const replyKey = `tg-active|${sender}|${text.slice(0, 50)}`;
  seenIds.add(replyKey);

  return true;
}

// ─────────────────────── Utilities ───────────────────────────────────────

function normIncludes(a, b) {
  const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return norm(a).includes(norm(b));
}

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
