/* chatbot.js — A Light in the Sky on-site chatbot widget
 *
 * Self-contained vanilla JS widget. Drop the script tag onto any page and the
 * widget appears as a floating button bottom-right that opens a chat panel.
 *
 * Talks to /api/chat which streams responses from the Anthropic Claude API.
 * Conversation history is kept in memory for the page session.
 */
(function () {
  if (window.__alitskyChatLoaded) return;
  window.__alitskyChatLoaded = true;

  // -------- Configuration --------
  const OPENING_MESSAGE =
    "Hi — I'm Sky, the AI assistant for A Light in the Sky. What kind of business do you run?";
  const ERROR_MESSAGE =
    "Something went wrong. Email us at admin@alitsky.com";
  const RATE_LIMIT_PREFIX = "You have reached the message limit";

  // Brand-aligned palette (matches the rest of the site)
  const COLOR = {
    headerBg: "#0E4858",      // deep-teal-700
    headerFg: "#ffffff",
    headerSub: "rgba(255,255,255,0.65)",
    userBubble: "#0E4858",
    userText: "#ffffff",
    botBubble: "#eef6f8",     // deep-teal-50
    botText: "#0B2030",       // ink-900
    timestamp: "#7A9298",
    sendBtn: "#3FC1D4",       // cyan-400
    sendBtnHover: "#7fd6e3",
    sendBtnText: "#06303a",
    inputBorder: "#E5E7EB",
    inputBg: "#ffffff",
    panelBg: "#ffffff",
    floatBg: "#0E4858",
    floatFg: "#ffffff",
    unreadDot: "#DC4413",
  };

  // -------- Safe HTML formatting for assistant messages --------
  // Escapes HTML, then re-applies a tiny subset of markdown plus auto-linking
  // for bare URLs (https://..., alitsky.com/...) and email addresses.
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeHref(url) {
    var u = String(url).trim();
    if (/^javascript:/i.test(u) || /^data:/i.test(u) || /^vbscript:/i.test(u)) return "#";
    if (/^(https?:\/\/|mailto:|tel:|\/)/i.test(u)) return u;
    return "https://" + u;
  }

  function formatAssistantMessage(rawText) {
    var text = escapeHtml(rawText);

    // Markdown link: [label](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, label, url) {
      return (
        '<a href="' +
        safeHref(url) +
        '" target="_blank" rel="noopener noreferrer">' +
        label +
        "</a>"
      );
    });

    // Bold: **text**
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

    // Italic: *text* (avoid matching inside ** already replaced)
    text = text.replace(
      /(^|[^*<])\*([^*\n<]+)\*(?!\*)/g,
      "$1<em>$2</em>"
    );

    // Emails: foo@bar.com → mailto link
    text = text.replace(
      /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
      '<a href="mailto:$1">$1</a>'
    );

    // Plain URLs: https://... or alitsky.com[/path]
    text = text.replace(
      /\b((?:https?:\/\/[^\s<]+)|(?:alitsky\.com(?:\/[^\s<]*)?))/gi,
      function (match) {
        // Skip if already inside an <a>...> (rough check: preceded by href=)
        // The regex won't match inside an attribute because we restrict on \s<
        // but trailing punctuation should not be part of the URL.
        var trail = match.match(/[.,;:!?)\]}]+$/);
        var url = match;
        var tail = "";
        if (trail) {
          url = match.slice(0, -trail[0].length);
          tail = trail[0];
        }
        var href = /^https?:\/\//i.test(url) ? url : "https://" + url;
        return (
          '<a href="' +
          href +
          '" target="_blank" rel="noopener noreferrer">' +
          url +
          "</a>" +
          tail
        );
      }
    );

    return text;
  }

  // -------- State --------
  const state = {
    open: false,
    sending: false,
    hasUnread: false,
    /** @type {{role:'user'|'assistant', content:string, ts:Date}[]} */
    messages: [],
  };

  // -------- Inject styles --------
  const styleEl = document.createElement("style");
  styleEl.textContent = `
    .alsy-chat-root, .alsy-chat-root * { box-sizing: border-box; }
    .alsy-chat-root {
      font-family: 'Sora', system-ui, -apple-system, Segoe UI, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .alsy-chat-float {
      position: fixed; right: 22px; bottom: 22px; z-index: 9998;
      width: 60px; height: 60px; border-radius: 999px;
      background: ${COLOR.floatBg}; color: ${COLOR.floatFg};
      border: 0; cursor: pointer; padding: 0;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 12px 28px -8px rgba(11,32,48,0.35), 0 4px 12px rgba(11,32,48,0.18);
      transition: transform 180ms cubic-bezier(0.22,1,0.36,1), box-shadow 180ms;
    }
    .alsy-chat-float:hover { transform: translateY(-2px); box-shadow: 0 18px 36px -10px rgba(11,32,48,0.45); }
    .alsy-chat-float:active { transform: translateY(0); }
    .alsy-chat-float svg { width: 26px; height: 26px; stroke: currentColor; fill: none; stroke-width: 1.8; }
    .alsy-chat-float-unread {
      position: absolute; top: 8px; right: 8px;
      width: 12px; height: 12px; border-radius: 999px;
      background: ${COLOR.unreadDot}; border: 2px solid #ffffff;
      display: none;
    }
    .alsy-chat-float.has-unread .alsy-chat-float-unread { display: block; }

    .alsy-chat-panel {
      position: fixed; right: 22px; bottom: 94px; z-index: 9999;
      width: 380px; height: 520px;
      background: ${COLOR.panelBg}; border-radius: 18px;
      box-shadow: 0 30px 60px -20px rgba(11,32,48,0.40), 0 8px 24px rgba(11,32,48,0.12);
      display: none; flex-direction: column; overflow: hidden;
      transform: translateY(12px) scale(0.98); opacity: 0;
      transition: transform 220ms cubic-bezier(0.22,1,0.36,1), opacity 220ms;
    }
    .alsy-chat-panel.is-open { display: flex; transform: translateY(0) scale(1); opacity: 1; }

    .alsy-chat-header {
      background: ${COLOR.headerBg}; color: ${COLOR.headerFg};
      padding: 14px 16px; display: flex; align-items: center; gap: 12px;
      flex: none;
    }
    .alsy-chat-logo {
      width: 30px; height: 30px; flex: none;
      filter: brightness(0) invert(1);
    }
    .alsy-chat-titles { flex: 1; min-width: 0; }
    .alsy-chat-title { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
    .alsy-chat-subtitle { font-size: 12px; color: ${COLOR.headerSub}; margin-top: 2px; display: flex; align-items: center; gap: 6px; }
    .alsy-chat-online-dot {
      width: 7px; height: 7px; border-radius: 999px; background: #3FC1D4;
      box-shadow: 0 0 0 0 rgba(63,193,212,0.6);
      animation: alsy-pulse 2s infinite;
    }
    @keyframes alsy-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(63,193,212,0.6); }
      70%  { box-shadow: 0 0 0 8px rgba(63,193,212,0); }
      100% { box-shadow: 0 0 0 0 rgba(63,193,212,0); }
    }
    .alsy-chat-close {
      background: transparent; border: 0; color: ${COLOR.headerFg};
      width: 32px; height: 32px; border-radius: 8px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      opacity: 0.75; transition: opacity 120ms, background 120ms;
    }
    .alsy-chat-close:hover { opacity: 1; background: rgba(255,255,255,0.08); }
    .alsy-chat-close svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 2; }

    .alsy-chat-messages {
      flex: 1; overflow-y: auto; padding: 18px 16px;
      display: flex; flex-direction: column; gap: 12px;
      background: ${COLOR.panelBg};
      scroll-behavior: smooth;
    }
    .alsy-chat-row { display: flex; flex-direction: column; max-width: 86%; }
    .alsy-chat-row.user { align-self: flex-end; align-items: flex-end; }
    .alsy-chat-row.bot { align-self: flex-start; align-items: flex-start; }
    .alsy-chat-bubble {
      padding: 10px 14px; border-radius: 14px;
      font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word;
    }
    .alsy-chat-row.user .alsy-chat-bubble {
      background: ${COLOR.userBubble}; color: ${COLOR.userText};
      border-bottom-right-radius: 6px;
    }
    .alsy-chat-row.bot .alsy-chat-bubble {
      background: ${COLOR.botBubble}; color: ${COLOR.botText};
      border-bottom-left-radius: 6px;
    }
    .alsy-chat-bubble a {
      color: inherit;
      text-decoration: underline;
      text-underline-offset: 2px;
      text-decoration-thickness: 1px;
      transition: color 120ms;
    }
    .alsy-chat-row.user .alsy-chat-bubble a {
      color: #ffffff;
      text-decoration-color: rgba(255,255,255,0.6);
    }
    .alsy-chat-row.bot .alsy-chat-bubble a {
      color: ${COLOR.userBubble};
      font-weight: 600;
      text-decoration-color: rgba(14,72,88,0.45);
    }
    .alsy-chat-row.bot .alsy-chat-bubble a:hover {
      text-decoration-color: ${COLOR.userBubble};
    }
    .alsy-chat-bubble strong { font-weight: 700; }
    .alsy-chat-bubble em { font-style: italic; }
    .alsy-chat-time {
      font-size: 10px; color: ${COLOR.timestamp};
      margin-top: 4px; padding: 0 4px;
      font-variant-numeric: tabular-nums;
    }
    .alsy-chat-typing {
      display: inline-flex; gap: 4px; align-items: center;
      padding: 12px 14px; background: ${COLOR.botBubble};
      border-radius: 14px; border-bottom-left-radius: 6px;
    }
    .alsy-chat-typing span {
      width: 6px; height: 6px; border-radius: 999px; background: ${COLOR.timestamp};
      animation: alsy-typing 1.2s infinite ease-in-out;
    }
    .alsy-chat-typing span:nth-child(2) { animation-delay: 0.15s; }
    .alsy-chat-typing span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes alsy-typing {
      0%, 80%, 100% { transform: scale(0.7); opacity: 0.5; }
      40%           { transform: scale(1);   opacity: 1; }
    }

    .alsy-chat-input-bar {
      flex: none; background: ${COLOR.inputBg};
      border-top: 1px solid ${COLOR.inputBorder};
      padding: 10px 10px 12px; display: flex; gap: 8px; align-items: flex-end;
    }
    .alsy-chat-input {
      flex: 1; resize: none; max-height: 96px;
      padding: 10px 12px; font: 400 14px/1.4 'Sora', system-ui, sans-serif;
      color: #0B2030; background: #F7FAFA;
      border: 1px solid ${COLOR.inputBorder};
      border-radius: 12px;
      outline: none;
      transition: border-color 140ms, box-shadow 140ms;
    }
    .alsy-chat-input:focus {
      border-color: ${COLOR.headerBg};
      box-shadow: 0 0 0 3px rgba(14,72,88,0.10);
    }
    .alsy-chat-input::placeholder { color: #9BB0BB; }
    .alsy-chat-send {
      width: 40px; height: 40px; border-radius: 999px;
      background: ${COLOR.sendBtn}; color: ${COLOR.sendBtnText};
      border: 0; cursor: pointer; flex: none;
      display: flex; align-items: center; justify-content: center;
      transition: background 140ms, transform 140ms;
    }
    .alsy-chat-send:hover:not(:disabled) { background: ${COLOR.sendBtnHover}; }
    .alsy-chat-send:active:not(:disabled) { transform: scale(0.96); }
    .alsy-chat-send:disabled { opacity: 0.4; cursor: not-allowed; }
    .alsy-chat-send svg { width: 18px; height: 18px; fill: currentColor; }

    @media (max-width: 520px) {
      .alsy-chat-panel {
        right: 0; bottom: 0; left: 0;
        width: 100%; height: 70vh; max-height: 560px;
        border-radius: 18px 18px 0 0;
      }
      .alsy-chat-float { right: 16px; bottom: 16px; }
    }
  `;
  document.head.appendChild(styleEl);

  // -------- Build DOM --------
  const root = document.createElement("div");
  root.className = "alsy-chat-root";

  // Floating button
  const floatBtn = document.createElement("button");
  floatBtn.className = "alsy-chat-float";
  floatBtn.setAttribute("aria-label", "Open chat");
  floatBtn.innerHTML = `
    <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
    <span class="alsy-chat-float-unread" aria-hidden="true"></span>
  `;

  // Panel
  const panel = document.createElement("div");
  panel.className = "alsy-chat-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Chat with A Light in the Sky");
  panel.innerHTML = `
    <div class="alsy-chat-header">
      <img class="alsy-chat-logo" src="/assets/logo-mark-reverse.svg" alt="">
      <div class="alsy-chat-titles">
        <div class="alsy-chat-title">A Light in the Sky</div>
        <div class="alsy-chat-subtitle">
          <span class="alsy-chat-online-dot"></span>
          Typically replies instantly
        </div>
      </div>
      <button class="alsy-chat-close" aria-label="Close chat">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div class="alsy-chat-messages" role="log" aria-live="polite" aria-atomic="false"></div>
    <form class="alsy-chat-input-bar" autocomplete="off">
      <textarea class="alsy-chat-input" rows="1" placeholder="Type your message..." aria-label="Type your message"></textarea>
      <button class="alsy-chat-send" type="submit" aria-label="Send">
        <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>
      </button>
    </form>
  `;

  root.appendChild(panel);
  root.appendChild(floatBtn);
  document.body.appendChild(root);

  const messagesEl = panel.querySelector(".alsy-chat-messages");
  const closeBtn = panel.querySelector(".alsy-chat-close");
  const form = panel.querySelector(".alsy-chat-input-bar");
  const input = panel.querySelector(".alsy-chat-input");
  const sendBtn = panel.querySelector(".alsy-chat-send");

  // -------- Helpers --------
  function nowStr() {
    const d = new Date();
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderMessage(role, content, ts) {
    const row = document.createElement("div");
    row.className = `alsy-chat-row ${role === "user" ? "user" : "bot"}`;
    const bubble = document.createElement("div");
    bubble.className = "alsy-chat-bubble";
    if (role === "user") {
      bubble.textContent = content; // user input rendered as plain text
    } else {
      bubble.innerHTML = formatAssistantMessage(content); // markdown + autolink
    }
    const time = document.createElement("div");
    time.className = "alsy-chat-time";
    time.textContent = ts || nowStr();
    row.appendChild(bubble);
    row.appendChild(time);
    messagesEl.appendChild(row);
    scrollToBottom();
    return bubble; // caller can re-render streamed text
  }

  function showTyping() {
    const row = document.createElement("div");
    row.className = "alsy-chat-row bot";
    row.dataset.typing = "1";
    row.innerHTML = `
      <div class="alsy-chat-typing">
        <span></span><span></span><span></span>
      </div>
    `;
    messagesEl.appendChild(row);
    scrollToBottom();
    return row;
  }

  function autosizeInput() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 96) + "px";
  }

  function setSending(busy) {
    state.sending = busy;
    sendBtn.disabled = busy;
    input.disabled = busy;
  }

  function openPanel() {
    state.open = true;
    panel.classList.add("is-open");
    floatBtn.classList.remove("has-unread");
    state.hasUnread = false;
    // First open: drop the opening message in.
    if (state.messages.length === 0) {
      state.messages.push({
        role: "assistant",
        content: OPENING_MESSAGE,
        ts: new Date(),
      });
      renderMessage("assistant", OPENING_MESSAGE);
    }
    setTimeout(() => input.focus(), 240);
  }

  function closePanel() {
    state.open = false;
    panel.classList.remove("is-open");
  }

  // -------- Sending logic --------
  async function sendMessage(text) {
    if (!text || state.sending) return;

    // 1. Render the user's message
    state.messages.push({ role: "user", content: text, ts: new Date() });
    renderMessage("user", text);

    setSending(true);
    const typingRow = showTyping();

    // 2. Build the payload (strip ts before sending)
    const payload = {
      messages: state.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        // Try to read JSON error
        let errMsg = ERROR_MESSAGE;
        try {
          const errBody = await response.json();
          if (errBody && errBody.error) errMsg = errBody.error;
        } catch (_) {}
        typingRow.remove();
        renderMessage("assistant", errMsg);
        state.messages.push({
          role: "assistant",
          content: errMsg,
          ts: new Date(),
        });
        setSending(false);
        return;
      }

      // 3. Stream the response
      typingRow.remove();
      const bubble = renderMessage("assistant", "");
      let assistantText = "";

      if (response.body && response.body.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          assistantText += chunk;
          bubble.innerHTML = formatAssistantMessage(assistantText);
          scrollToBottom();
        }
      } else {
        // Fallback: no streaming support, read whole body
        assistantText = await response.text();
        bubble.innerHTML = formatAssistantMessage(assistantText);
        scrollToBottom();
      }

      state.messages.push({
        role: "assistant",
        content: assistantText || ERROR_MESSAGE,
        ts: new Date(),
      });

      // 4. If chat is closed (rare since we just sent), flag unread
      if (!state.open) {
        state.hasUnread = true;
        floatBtn.classList.add("has-unread");
      }
    } catch (err) {
      if (window.console) console.error("Chat error:", err);
      typingRow.remove();
      renderMessage("assistant", ERROR_MESSAGE);
      state.messages.push({
        role: "assistant",
        content: ERROR_MESSAGE,
        ts: new Date(),
      });
    } finally {
      setSending(false);
      input.focus();
    }
  }

  // -------- Event wiring --------
  floatBtn.addEventListener("click", () => {
    if (state.open) closePanel();
    else openPanel();
  });
  closeBtn.addEventListener("click", closePanel);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    autosizeInput();
    sendMessage(text);
  });

  input.addEventListener("input", autosizeInput);
  input.addEventListener("keydown", (e) => {
    // Enter sends, Shift+Enter newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });
})();
