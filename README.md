# Busy Bot — Auto Reply DnD

An AI-powered Chrome extension that automatically replies to WhatsApp and Telegram messages while you're busy, using Google Gemini.

---

## What It Does

- Watches WhatsApp Web and Telegram Web for new messages
- When a message arrives during your Do Not Disturb hours, the AI sends a warm, personalized reply
- Replies up to **10 times per sender per day** (configurable)
- Shows you a live reasoning log of every step the agent takes

---

## Setup — 5 Steps

### Step 1 — Get a Gemini API Key

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Click **Get API Key** → **Create API key**
3. Copy the key (starts with `AIzaSy…`)

---

### Step 2 — Put the API Key in `config.js`

Open `config.js` and replace the key on line 6:

```js
export const GEMINI_API_KEY = 'AIzaSy…YOUR_KEY_HERE…';
```

---

### Step 3 — Generate Icons

1. Open `generate-icons.html` in Chrome (double-click the file)
2. Click the download buttons to save **icon16.png**, **icon48.png**, **icon128.png**
3. Move all 3 files into the `icons/` folder

---

### Step 4 — Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `AutoReplyDnD` folder
5. The Busy Bot icon appears in your toolbar

---

### Step 5 — Configure Settings

1. Click the Busy Bot icon → click **⚙️ Settings**
2. Enter your Gemini API key (if you didn't edit `config.js`)
3. Set your **DnD hours** (e.g. 09:00 – 18:00) — bot only replies during this window
4. Optionally set a **custom reply template** using `{name}` as a placeholder
5. Click **Save Settings**

---

## How to Use

| Action | What to do |
|--------|-----------|
| Turn on auto-reply | Click the bot icon → toggle the **ON/OFF** switch |
| See agent reasoning | The popup shows each step the AI took |
| View Gemini API logs | Click **📋** button in the popup |
| Clear reply history | Settings → **Reset "Already Replied Today" History** |
| Clear logs | Click **Clear** in the popup or LLM Logs page |

**Keep these tabs open** while the bot is running:
- `web.whatsapp.com`
- `web.telegram.org/k/`

---

## File Structure

```
AutoReplyDnD/
├── manifest.json          # Chrome extension config
├── config.js              # Gemini API key + model name
├── background/
│   └── background.js      # AI agent loop (runs in background)
├── content/
│   ├── whatsapp.js        # Watches WhatsApp Web for new messages
│   └── telegram.js        # Watches Telegram Web for new messages
├── popup/
│   ├── popup.html         # Extension popup UI
│   └── popup.js           # Popup logic
├── settings/
│   ├── settings.html      # Settings page
│   └── settings.js        # Settings logic
├── logs/
│   ├── logs.html          # LLM call log viewer
│   └── logs.js            # Log viewer logic
├── icons/                 # Extension icons (generate from generate-icons.html)
└── generate-icons.html    # Open in browser to create icons
```

---

## How the AI Agent Works

Every new message triggers a 4-step sequence:

```
Step 1 → check_dnd_schedule      Is DnD active right now?
Step 2 → scan_for_new_messages   What did they say?
Step 3 → get_sender_context      Have I already replied to them today?
Step 4 → send_auto_reply         Compose and send the reply
```

If any step says "stop" (DnD not active, daily limit reached), the bot stops and explains why in the popup.

---

## Troubleshooting

**Bot not replying?**
- Make sure the toggle is **ON** in the popup
- Check that the current time is inside your DnD hours
- Check the LLM Logs page (📋 button) for errors

**"Chat not found" error?**
- The target chat must be visible in the sidebar (scroll up if needed)
- On Telegram, keep the chat list open in left column

**HTTP 503 error in logs?**
- Gemini API is temporarily overloaded — the bot will retry on the next message

**Duplicate messages on Telegram?**
- Reload the extension at `chrome://extensions` → click the refresh icon on Busy Bot

---

## Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| DnD Start | 09:00 | Bot starts replying at this time |
| DnD End | 18:00 | Bot stops replying at this time |
| Max replies/sender/day | 10 | Stops replying to the same person after this count |
| Custom template | (empty) | Fixed reply text; leave blank for AI-generated replies |
