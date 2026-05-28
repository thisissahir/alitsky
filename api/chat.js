// /api/chat — Vercel Serverless Function
// Calls the Anthropic Claude API for the on-site chatbot widget.
// Streams text back to the browser as it arrives.
//
// Environment variables (set in Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY     required — get from https://console.anthropic.com
//
// Rate limit: 20 messages per IP per hour. In-memory per function instance
// (resets on cold start). Good enough for a launch. If abuse becomes a real
// problem, swap for Upstash Redis or Vercel KV later.

// Handle both CJS shapes the SDK can export depending on bundler/version.
const AnthropicLib = require("@anthropic-ai/sdk");
const Anthropic = AnthropicLib.default || AnthropicLib;
const { Resend } = require("resend");

const SYSTEM_PROMPT = `You are Sky, the AI assistant for A Light in the Sky (ALITSKY), a web services and AI automation agency based in Denver, Colorado. Your job is to help business owners understand what ALITSKY does, answer questions about services and pricing, and guide them toward booking a free marketing audit.

YOUR NAME:
You are called Sky. If anyone asks your name, say "I'm Sky." If anyone asks what you are, say you're Sky, the AI assistant for A Light in the Sky, and that you are an example of what ALITSKY builds for clients.

ABOUT ALITSKY:
A Light in the Sky helps local businesses get found online and run more efficiently. The core belief: good businesses fail because they are invisible. ALITSKY fixes that.

Website: alitsky.com
Contact: admin@alitsky.com
Location: Denver, Colorado
Audit page: alitsky.com/audit

THE SERVICES:

1. GEO: Generative Engine Optimization — $799 one-time, $250–$500/mo retainer
The flagship service. Makes businesses visible to AI systems like ChatGPT, Claude, and Perplexity when customers ask for recommendations. Most local businesses have not done this yet. That is the advantage.

2. Website — $800–$2,000 one-time, $150–$200/mo retainer
Hand-built, fast, mobile-ready websites. Under 2 seconds load time. GEO-ready from day one. Includes free marketing audit. Also builds e-commerce and online stores.

3. AI Bot on Website — $500–$1,200 one-time, $150–$300/mo retainer
Custom AI chatbots trained on the client's business. Answers questions, qualifies leads, books appointments 24/7. (This chatbot is an example of what we build.)

4. SEO — $500–$1,200 one-time, $150–$300/mo retainer
Traditional search engine optimisation. Covers customers who type into Google. Works alongside GEO.

5. Marketing Audit — Free with any build, $297 standalone
Full analysis of online presence, AI visibility, competitor comparison, and action plan. Delivered in 72hrs.

6. AI Agents & Automation — $1,200–$3,500 one-time, $300–$600/mo retainer
Custom AI agents that handle repetitive business tasks — lead follow-up, review requests, proposal generation, appointment reminders. Built for the specific business.

7. HubSpot CRM Buildout — $1,000–$2,500 one-time, $300–$500/mo retainer
Full CRM setup. Every lead captured, every client tracked, every follow-up sent on time.

THE BUNDLES:

Visibility Package — $2,000–$4,500 one-time, $450–$750/mo retainer
Includes: GEO + Website + SEO + Free Marketing Audit

Visibility + Conversion Package — $4,000–$7,500 one-time, $650–$1,100/mo retainer
Includes: GEO + Website + SEO + AI Receptionist + Business Automations + Free Marketing Audit

Complete Operating System — $5,500–$10,000 one-time, $900–$1,500/mo retainer
Includes: Everything. GEO + Website + SEO + AI Bot + AI Agents + CRM + Free Marketing Audit

Post-delivery support: $75/hour after 7-day window.

HOW YOU BEHAVE:
- Warm, direct, plain English. No jargon.
- Never pitch before you understand what the business needs.
- Ask one question at a time to understand their situation.
- When relevant, explain WHY GEO matters right now — the window is closing, most competitors haven't done it.
- When someone asks about pricing, give the range clearly and suggest the free audit as the best starting point.
- Always end with a gentle pull toward the free audit at alitsky.com/audit — frame it as "one honest conversation."
- When sharing the audit page or other links, write the URL as bare text (e.g. alitsky.com/audit) — the chat widget auto-converts URLs into clickable links.
- Never make up services or pricing not listed above.
- Keep responses concise — 2-4 sentences max unless they ask for detail.
- If someone seems ready to move forward, say: "The best next step is the free marketing audit — takes 2 minutes and we will tell you exactly where your business stands. alitsky.com/audit"`;

// ---- Rate limit (in-memory, per function instance) ----
const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const buckets = new Map();

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = buckets.get(ip);
  if (!entry || now > entry.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

// ---- Summary-email logic ----
// After every chat response we may want to email a conversation summary to
// the team at admin@alitsky.com. Two triggers (either is enough):
//   1. The total conversation reaches a multiple of 8 messages (one summary
//      per "8 message exchange milestone" — 8, 16, 24, ...)
//   2. The user's last message contains a goodbye-ish signal
const CLOSING_SIGNALS = [
  "thanks",
  "thank you",
  "thank u",
  "bye",
  "goodbye",
  "good bye",
  "that's all",
  "thats all",
  "that is all",
  "got it",
  "perfect",
  "great",
];

function hasClosingSignal(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return CLOSING_SIGNALS.some((sig) => {
    const escaped = sig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("\\b" + escaped + "\\b", "i");
    return re.test(lower);
  });
}

function shouldSendSummary(fullConversation) {
  const total = fullConversation.length;
  if (total > 0 && total % 8 === 0) return true;
  // Check the most recent user message for a closing signal.
  for (let i = fullConversation.length - 1; i >= 0; i--) {
    const msg = fullConversation[i];
    if (msg.role === "user") return hasClosingSignal(msg.content);
  }
  return false;
}

function formatConversationPlain(conv) {
  return conv
    .map((m) => (m.role === "user" ? "Visitor" : "ALITSKY") + ": " + m.content)
    .join("\n\n");
}

function formatConversationHtml(conv) {
  return conv
    .map((m) => {
      const who = m.role === "user" ? "Visitor" : "ALITSKY";
      const color = m.role === "user" ? "#0E4858" : "#137F8E";
      return (
        '<p style="margin:0 0 14px;font-size:14px;line-height:1.55;">' +
        '<strong style="color:' + color + ';">' + who + ':</strong> ' +
        escapeHtml(m.content) +
        "</p>"
      );
    })
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendChatSummary(client, fullConversation) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("Skipping chat summary: RESEND_API_KEY not set");
    return;
  }

  const conversationPlain = formatConversationPlain(fullConversation);
  const conversationHtml = formatConversationHtml(fullConversation);

  // 1. Ask Claude to summarize.
  let summaryText = "";
  try {
    const summaryResp = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content:
            "Summarize this conversation in 5 bullet points maximum. Include: what business the visitor runs, what services they asked about, what their main problem or goal is, whether they seemed ready to buy or just browsing, and any specific details they mentioned. Be concise and direct. Format as bullet points.\n\n--- CONVERSATION ---\n" +
            conversationPlain,
        },
      ],
    });
    if (
      summaryResp &&
      Array.isArray(summaryResp.content) &&
      summaryResp.content[0] &&
      summaryResp.content[0].type === "text"
    ) {
      summaryText = summaryResp.content[0].text || "";
    }
  } catch (err) {
    console.error("Chat summary: Claude summarization failed:", err);
    summaryText = "(Summary unavailable — Claude summarization failed.)";
  }

  // 2. Compose the email.
  const firstUserMsg =
    (fullConversation.find((m) => m.role === "user") || {}).content || "";
  const first6Words = firstUserMsg
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ")
    .slice(0, 80);
  const subject =
    "New chat conversation — " + (first6Words || "visitor");

  const now = new Date().toLocaleString("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const text = [
    "NEW CHAT CONVERSATION SUMMARY",
    "Date: " + now + " (Denver)",
    "",
    "SUMMARY:",
    summaryText,
    "",
    "FULL CONVERSATION:",
    conversationPlain,
  ].join("\n");

  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;color:#0B2030;line-height:1.55;font-size:15px;max-width:640px;">' +
      '<h2 style="font-size:18px;margin:0 0 6px;letter-spacing:-0.01em;">New chat conversation</h2>' +
      '<div style="font-size:12px;color:#5d7382;margin-bottom:24px;">' + escapeHtml(now) + " (Denver)</div>" +
      '<h3 style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#137F8E;margin:0 0 10px;">Summary</h3>' +
      '<div style="font-size:14.5px;line-height:1.6;margin-bottom:24px;white-space:pre-wrap;">' + escapeHtml(summaryText) + "</div>" +
      '<h3 style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#137F8E;margin:0 0 12px;">Full conversation</h3>' +
      '<div style="border-left:3px solid #eef6f8;padding:6px 0 6px 14px;">' + conversationHtml + "</div>" +
    "</div>";

  // 3. Send via Resend (reuses existing env vars from /api/audit + /api/contact).
  const resend = new Resend(process.env.RESEND_API_KEY);
  const to = process.env.AUDIT_TO_EMAIL || "admin@alitsky.com";
  const from =
    process.env.AUDIT_FROM_EMAIL ||
    "A Light in the Sky <onboarding@resend.dev>";

  const { error } = await resend.emails.send({
    from,
    to: [to],
    subject,
    text,
    html,
  });
  if (error) {
    console.error("Chat summary: Resend rejected:", error);
  }
}

// ---- Handler ----
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (isRateLimited(clientIp(req))) {
    return res.status(429).json({
      error:
        "You have reached the message limit. Email us directly at admin@alitsky.com",
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (_) {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }
  const messages = (body || {}).messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Missing or empty messages array" });
  }

  // Defensive: only accept the user/assistant role messages from the client.
  // System prompt lives server-side only.
  const cleanMessages = messages
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (!cleanMessages.length) {
    return res
      .status(400)
      .json({ error: "No valid user/assistant messages provided" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set");
    return res.status(500).json({ error: "Chatbot is not configured" });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    // Stream tokens back to the browser as plain text.
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no"); // disables proxy buffering

    const stream = await client.messages.stream({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: cleanMessages,
    });

    // Capture the full assistant reply so we can summarize the conversation
    // after streaming finishes (if the trigger conditions are met).
    let assistantText = "";
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta &&
        event.delta.type === "text_delta"
      ) {
        res.write(event.delta.text);
        assistantText += event.delta.text;
      }
    }
    res.end();

    // Background: maybe send a conversation summary to admin@alitsky.com.
    // The user's response has already streamed back; this only affects how
    // long the serverless function stays alive. Wrapped in try/catch so any
    // failure here is silent and can't impact the chat UX.
    try {
      const fullConversation = cleanMessages.concat([
        { role: "assistant", content: assistantText },
      ]);
      if (shouldSendSummary(fullConversation)) {
        await sendChatSummary(client, fullConversation);
      }
    } catch (err) {
      console.error("Chat summary email failed (silent):", err);
    }
  } catch (err) {
    console.error("Chat API error:", err);
    // If we already started streaming we can't send JSON — just end the stream.
    if (res.headersSent) {
      try {
        res.end();
      } catch (_) {}
      return;
    }
    return res.status(500).json({ error: "Something went wrong" });
  }
};

// Give the function up to 30s so the streamed reply (~10s max) plus the
// optional summary email (Claude summary + Resend send, usually 2-5s) can
// finish before Vercel kills the invocation. Hobby tier allows up to 60s.
module.exports.config = {
  maxDuration: 30,
};
