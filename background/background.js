// background/background.js — Agentic loop with GUIDED sequential tool calls
// Each step forces Gemini to call exactly the right function via allowed_function_names.
// This prevents Gemini from skipping steps (the AUTO-mode bug seen in production).

import { GEMINI_API_KEY as DEFAULT_KEY, GEMINI_MODEL } from '../config.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = `You are an AI assistant managing auto-replies for a busy user.

The user is BUSY and cannot respond manually. Your job is to detect
new messages and send a warm, personalized reply on their behalf.

You have 4 tools called in sequence:

STEP 1 → check_dnd_schedule()
STEP 2 → scan_for_new_messages()
STEP 3 → get_sender_context(sender_name)
STEP 4 → send_auto_reply(platform, sender, reply_text)

For send_auto_reply, compose a reply that:
✅ Addresses sender by name
✅ Mentions user is busy / in a meeting
✅ Promises to get back soon
✅ Is warm and human, never robotic
✅ Is under 2 sentences
✅ Ends with a friendly emoji`;

const FUNCTION_DECLARATIONS = [
  {
    name: 'check_dnd_schedule',
    description: 'Check if Do Not Disturb is currently active.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'scan_for_new_messages',
    description: 'Return the pending new unread message details.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_sender_context',
    description: 'Get sender context: reply history and message frequency.',
    parameters: {
      type: 'object',
      properties: {
        sender_name: { type: 'string', description: 'The message sender name' }
      },
      required: ['sender_name']
    }
  },
  {
    name: 'send_auto_reply',
    description: 'Send a warm auto-reply to the sender.',
    parameters: {
      type: 'object',
      properties: {
        platform:   { type: 'string', enum: ['whatsapp', 'telegram'] },
        sender:     { type: 'string' },
        reply_text: { type: 'string', description: 'Warm reply, under 2 sentences, ends with emoji' }
      },
      required: ['platform', 'sender', 'reply_text']
    }
  }
];

const STEP_ORDER = {
  check_dnd_schedule:    1,
  scan_for_new_messages: 2,
  get_sender_context:    3,
  send_auto_reply:       4
};

// ─────────────────────────── Runtime State ────────────────────────────────

let pendingMessages = [];
let isAgentRunning  = false;
let currentChain    = [];

// ─────────────────────────── Message Router ───────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'TAB_READY':
        await chrome.storage.session.set({ [`tabId_${msg.platform}`]: sender.tab?.id });
        sendResponse({ ok: true });
        break;

      case 'NEW_MESSAGE': {
        const { enabled } = await chrome.storage.local.get('enabled');
        if (enabled) {
          pendingMessages.push({ ...msg, tabId: sender.tab?.id });
          if (!isAgentRunning) runNextMessage();
        }
        sendResponse({ received: true });
        break;
      }

      case 'GET_STATE':
        sendResponse(await buildStateSnapshot());
        break;

      case 'TOGGLE_ENABLED':
        await chrome.storage.local.set({ enabled: msg.enabled });
        broadcast({ type: 'STATE_CHANGE', enabled: msg.enabled });
        sendResponse({ ok: true });
        break;

      case 'CLEAR_LOG':
        await chrome.storage.local.set({ replyLog: [], reasoningChain: [] });
        currentChain = [];
        broadcast({ type: 'LOG_CLEARED' });
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({});
    }
  })();
  return true;
});

// ─────────────────────────── State Snapshot ───────────────────────────────

async function buildStateSnapshot() {
  const data = await chrome.storage.local.get([
    'enabled', 'replyLog', 'reasoningChain',
    'dndStart', 'dndEnd', 'geminiApiKey', 'customTemplate'
  ]);
  return {
    enabled:        data.enabled        ?? false,
    replyLog:       data.replyLog       ?? [],
    reasoningChain: data.reasoningChain ?? [],
    dndStart:       data.dndStart       ?? '09:00',
    dndEnd:         data.dndEnd         ?? '18:00',
    customTemplate: data.customTemplate ?? '',
    hasApiKey:      !!(data.geminiApiKey || DEFAULT_KEY),
    isAgentRunning
  };
}

// ─────────────────────────── Agent Orchestrator ───────────────────────────

async function runNextMessage() {
  if (isAgentRunning || pendingMessages.length === 0) return;
  isAgentRunning = true;
  currentChain   = [];

  const pendingMsg = pendingMessages.shift();
  broadcast({ type: 'AGENT_STARTED', platform: pendingMsg.platform, sender: pendingMsg.sender });

  try {
    await runAgentLoop(pendingMsg);
  } catch (err) {
    console.error('[BusyBot] Unhandled agent error:', err);
    pushStep('error', 'Agent Error', `${err.message}`, 'failed');
    await persistChain();
  } finally {
    isAgentRunning = false;
    broadcast({ type: 'AGENT_DONE' });
    if (pendingMessages.length > 0) setTimeout(runNextMessage, 400);
  }
}

// ─────────────────────────── Guided Agent Loop ────────────────────────────
//
// Instead of mode:"AUTO" (which lets Gemini stop early), we use mode:"ANY"
// with allowed_function_names to force exactly which tool is called at each step.
// This guarantees Steps 3 and 4 execute when Steps 1 and 2 pass.

async function runAgentLoop(pendingMsg) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  const apiKey = geminiApiKey?.trim() || DEFAULT_KEY;

  const contents = [
    {
      role: 'user',
      parts: [{
        text: `New incoming message. Platform: ${pendingMsg.platform}, Sender: "${pendingMsg.sender}", Text: "${pendingMsg.text}". Run the 4-step tool sequence.`
      }]
    }
  ];

  // ── Guided sequence: each entry forces a specific tool ────────────────
  const sequence = [
    {
      fn:    'check_dnd_schedule',
      label: 1,
      stop:  r => !r.should_reply,
      stopMsg: r => `DND not active (${r.current_time} outside ${r.dnd_start}–${r.dnd_end}). No reply sent.`
    },
    {
      fn:    'scan_for_new_messages',
      label: 2,
      stop:  r => !r.messages_found,
      stopMsg: () => 'No pending message found. Nothing to reply to.'
    },
    {
      fn:    'get_sender_context',
      label: 3,
      stop:  r => r.already_replied_today,
      stopMsg: r => `Daily limit reached — replied ${r.replies_today}/${r.max_replies_per_day} times today to ${r.sender_name}. Skipping.`
    },
    {
      fn:    'send_auto_reply',
      label: 4,
      stop:  () => false,
      stopMsg: () => ''
    }
  ];

  for (const step of sequence) {
    // Force Gemini to call this exact function (mode ANY + allowed_function_names)
    let response;
    try {
      response = await callGemini(apiKey, contents, [step.fn]);
    } catch (err) {
      pushStep('error', `Step ${step.label} — ${step.fn}() Error`, err.message, 'failed');
      await persistChain();
      return;
    }

    const candidate  = response.candidates?.[0];
    const modelParts = candidate?.content?.parts ?? [];
    contents.push({ role: 'model', parts: modelParts });

    // Extract the forced function call
    const fnCallPart = modelParts.find(p => p.functionCall);
    if (!fnCallPart) {
      // Gemini returned text instead of a tool call — unexpected
      const txt = modelParts.filter(p => p.text).map(p => p.text).join('\n').trim();
      pushStep('error', `Step ${step.label} — unexpected text`, txt || 'Gemini did not call the tool.', 'failed');
      await persistChain();
      return;
    }

    const { name, args = {} } = fnCallPart.functionCall;

    // Show step as running in the UI
    pushStep(name, `Step ${step.label} — ${name}()`, 'Executing…', 'running');

    // Execute the tool (local logic — no network needed for Steps 1–3)
    const result = await dispatchTool(name, args, pendingMsg);

    // Finalize the step card in the UI
    finalizeStep(name, args, result, step.label);

    // Feed result back into the conversation history
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name, response: result } }]
    });

    // Check early-stop condition
    if (step.stop(result)) {
      const stopText = step.stopMsg(result);
      pushStep('summary', '🧠 Agent Summary', stopText, 'summary');
      await persistChain();
      return;
    }
  }

  // ── All 4 steps passed — get Gemini's closing summary (mode NONE = text only)
  try {
    const summaryResp = await callGemini(apiKey, contents, null);
    const summaryText = (summaryResp.candidates?.[0]?.content?.parts ?? [])
      .filter(p => p.text).map(p => p.text).join('\n').trim();
    pushStep('summary', '🧠 Agent Summary', summaryText || 'All 4 steps completed. Reply sent.', 'summary');
  } catch {
    pushStep('summary', '🧠 Agent Summary', 'All 4 steps completed. Reply sent.', 'summary');
  }

  await persistChain();
}

// ─────────────────────────── Tool Implementations ─────────────────────────

async function dispatchTool(name, args, pendingMsg) {
  switch (name) {
    case 'check_dnd_schedule':    return toolCheckDnd();
    case 'scan_for_new_messages': return toolScanMessages(pendingMsg);
    case 'get_sender_context':    return toolGetContext(args.sender_name, pendingMsg.platform);
    case 'send_auto_reply':       return toolSendReply(args.platform, args.sender, args.reply_text, pendingMsg);
    default: return { error: `Unknown tool: ${name}`, should_stop: true };
  }
}

async function toolCheckDnd() {
  const { dndStart = '09:00', dndEnd = '18:00' } = await chrome.storage.local.get(['dndStart', 'dndEnd']);
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = dndStart.split(':').map(Number);
  const [eh, em] = dndEnd.split(':').map(Number);
  const active  = cur >= sh * 60 + sm && cur < eh * 60 + em;
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return {
    should_reply: active,
    dnd_start:    dndStart,
    dnd_end:      dndEnd,
    current_time: timeStr,
    message: active
      ? `DND Active | ${dndStart}–${dndEnd} | Now: ${timeStr}`
      : `DND Inactive | Now: ${timeStr} — outside ${dndStart}–${dndEnd}`
  };
}

async function toolScanMessages(pendingMsg) {
  if (!pendingMsg?.sender) {
    return { messages_found: false, message: 'No pending message.' };
  }
  return {
    messages_found: true,
    platform: pendingMsg.platform,
    sender:   pendingMsg.sender,
    text:     pendingMsg.text,
    message:  `📨 ${pendingMsg.sender}: "${pendingMsg.text}"`
  };
}

async function toolGetContext(senderName, platform) {
  const { replyLog = [], repliedToday = {}, maxRepliesPerDay = 10 } =
    await chrome.storage.local.get(['replyLog', 'repliedToday', 'maxRepliesPerDay']);

  const today = new Date().toDateString();
  const key   = `${senderName}_${platform}`;
  const entry = repliedToday[key];

  // Count how many times we've already replied to this sender today
  const repliesToday   = (entry?.date === today) ? (entry.count ?? 1) : 0;
  const limitReached   = repliesToday >= maxRepliesPerDay;

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekCount = replyLog.filter(e =>
    e.sender === senderName && e.platform === platform && e.timestamp > weekAgo
  ).length;
  const rel = weekCount > 5 ? 'Frequent Contact' : weekCount > 0 ? 'Occasional Contact' : 'New Contact';

  return {
    already_replied_today:   limitReached,
    sender_name:             senderName,
    replies_today:           repliesToday,
    max_replies_per_day:     maxRepliesPerDay,
    message_count_this_week: weekCount,
    relationship:            rel,
    message: limitReached
      ? `Daily limit reached — replied ${repliesToday}/${maxRepliesPerDay} times today to ${senderName}`
      : `Replied ${repliesToday}/${maxRepliesPerDay} times today | ${rel}`
  };
}

async function toolSendReply(platform, sender, replyText, pendingMsg) {
  const { customTemplate } = await chrome.storage.local.get('customTemplate');
  let finalText = replyText;
  if (customTemplate?.trim()) {
    finalText = customTemplate.replace(/\{name\}/gi, sender);
  }

  let actuallySent = false;
  try {
    const session = await chrome.storage.session.get(`tabId_${platform}`);
    const tabId   = session[`tabId_${platform}`] ?? pendingMsg.tabId;
    if (tabId) {
      const r = await chrome.tabs.sendMessage(tabId, {
        type: 'SEND_REPLY', platform, sender, text: finalText, chatId: pendingMsg.chatId
      });
      actuallySent = r?.success ?? false;
    }
  } catch (err) {
    console.warn('[BusyBot] DOM reply failed:', err.message);
  }

  const now     = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  await appendReplyLog({ sender, platform, text: finalText, time: timeStr, timestamp: now.getTime() });
  await markRepliedToday(sender, platform);
  broadcast({ type: 'REPLY_LOGGED', entry: { sender, platform, text: finalText, time: timeStr } });

  return {
    success:               true,
    actually_sent_via_dom: actuallySent,
    sender, platform,
    reply_text: finalText,
    time: timeStr,
    message: `💬 Sent to ${sender} at ${timeStr}: "${finalText}"`
  };
}

// ─────────────────────────── Storage Helpers ──────────────────────────────

async function appendReplyLog(entry) {
  const { replyLog = [] } = await chrome.storage.local.get('replyLog');
  replyLog.unshift(entry);
  if (replyLog.length > 100) replyLog.length = 100;
  await chrome.storage.local.set({ replyLog });
}

async function markRepliedToday(sender, platform) {
  const { repliedToday = {} } = await chrome.storage.local.get('repliedToday');
  const today = new Date().toDateString();
  const key   = `${sender}_${platform}`;
  const entry = repliedToday[key];

  if (entry?.date === today) {
    repliedToday[key] = { date: today, count: (entry.count ?? 1) + 1 };
  } else {
    repliedToday[key] = { date: today, count: 1 };
  }
  await chrome.storage.local.set({ repliedToday });
}

// ─────────────────────────── Reasoning Chain UI ───────────────────────────

function pushStep(toolName, title, detail, status) {
  currentChain.push({ toolName, title, detail, status, timestamp: Date.now() });
  broadcast({ type: 'REASONING_UPDATE', chain: [...currentChain] });
}

function finalizeStep(toolName, args, result, stepNum) {
  const labels = {
    check_dnd_schedule:    'check_dnd_schedule()',
    scan_for_new_messages: 'scan_for_new_messages()',
    get_sender_context:    `get_sender_context("${args.sender_name ?? ''}")`,
    send_auto_reply:       'send_auto_reply()'
  };
  const idx = currentChain.findLastIndex(s => s.status === 'running');
  if (idx >= 0) {
    currentChain[idx] = {
      ...currentChain[idx],
      title:  `Step ${stepNum} — ${labels[toolName] ?? toolName}`,
      detail: result.message ?? JSON.stringify(result),
      status: 'done'
    };
  }
  broadcast({ type: 'REASONING_UPDATE', chain: [...currentChain] });
}

async function persistChain() {
  await chrome.storage.local.set({ reasoningChain: currentChain });
}

// ─────────────────────────── Gemini API Call ──────────────────────────────
//
// allowedFunctions:
//   string[]  → mode ANY, forces exactly those functions (used for Steps 1–4)
//   null      → mode NONE, Gemini returns plain text (used for final summary)

async function callGemini(apiKey, contents, allowedFunctions) {
  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const toolConfig = allowedFunctions
    ? { function_calling_config: { mode: 'ANY', allowed_function_names: allowedFunctions } }
    : { function_calling_config: { mode: 'NONE' } };

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    tools:      [{ function_declarations: FUNCTION_DECLARATIONS }],
    tool_config: toolConfig,
    contents,
    generation_config: { max_output_tokens: 512, temperature: 0.4 }
  };

  // ── LLM Request log ──────────────────────────────────────────────────────
  const logEntry = {
    id:        Date.now(),
    timestamp: new Date().toISOString(),
    direction: 'REQUEST',
    model:     GEMINI_MODEL,
    forcing:   allowedFunctions ?? 'text-only (NONE)',
    messages:  contents.map(c => ({
      role:  c.role,
      parts: c.parts.map(p =>
        p.text          ? { type: 'text',             text: p.text.slice(0, 300) }
        : p.functionCall    ? { type: 'functionCall',    name: p.functionCall.name, args: p.functionCall.args }
        : p.functionResponse ? { type: 'functionResponse', name: p.functionResponse.name }
        : p
      )
    }))
  };
  console.group(`%c[BusyBot/Gemini] ▶ REQUEST — forcing: ${JSON.stringify(allowedFunctions)}`, 'color:#5ba4ff;font-weight:bold');
  console.log('Turn count:', contents.length);
  console.log('Last user message:', contents.at(-1));
  console.groupEnd();

  await appendLlmLog(logEntry);
  broadcast({ type: 'LLM_LOG', entry: logEntry });

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const errLog  = { id: Date.now(), timestamp: new Date().toISOString(), direction: 'ERROR',
                      status: res.status, body: errBody.slice(0, 500) };
    await appendLlmLog(errLog);
    broadcast({ type: 'LLM_LOG', entry: errLog });
    throw new Error(`Gemini ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();

  // ── LLM Response log ─────────────────────────────────────────────────────
  const candidate  = data.candidates?.[0];
  const parts      = candidate?.content?.parts ?? [];
  const fnCalls    = parts.filter(p => p.functionCall).map(p => p.functionCall.name);
  const textParts  = parts.filter(p => p.text).map(p => p.text.slice(0, 200));
  const usage      = data.usageMetadata ?? {};

  const respLog = {
    id:           Date.now(),
    timestamp:    new Date().toISOString(),
    direction:    'RESPONSE',
    finishReason: candidate?.finishReason ?? 'unknown',
    functionCalls: fnCalls,
    textSnippet:  textParts.join(' | ').slice(0, 300),
    usage: {
      promptTokens:     usage.promptTokenCount     ?? '—',
      candidateTokens:  usage.candidatesTokenCount ?? '—',
      totalTokens:      usage.totalTokenCount      ?? '—'
    }
  };

  console.group(`%c[BusyBot/Gemini] ◀ RESPONSE — ${fnCalls.length ? 'tool call: ' + fnCalls.join(', ') : 'text'}`, 'color:#3dba72;font-weight:bold');
  console.log('Function calls:', fnCalls.length ? fnCalls : 'none');
  console.log('Text:', textParts.join('\n') || '(none)');
  console.log('Tokens — prompt:', respLog.usage.promptTokens,
              '| output:', respLog.usage.candidateTokens,
              '| total:', respLog.usage.totalTokens);
  console.groupEnd();

  await appendLlmLog(respLog);
  broadcast({ type: 'LLM_LOG', entry: respLog });

  return data;
}

// ─────────────────────────── LLM Log Storage ──────────────────────────────

async function appendLlmLog(entry) {
  const { llmLogs = [] } = await chrome.storage.local.get('llmLogs');
  llmLogs.unshift(entry);
  if (llmLogs.length > 200) llmLogs.length = 200;
  await chrome.storage.local.set({ llmLogs });
}

// ─────────────────────────── Popup Broadcast ──────────────────────────────

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
