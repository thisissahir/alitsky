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

const SYSTEM_PROMPT = `You are Sky, the assistant for A Light in the Sky (ALITSKY), a Client Capture Systems studio for service businesses, based in Indianapolis, Indiana and serving businesses nationwide. Your job is to help business owners understand what ALITSKY does, answer questions about the system and pricing, and guide them toward booking a free 45-minute call.

YOUR NAME:
You are called Sky. If anyone asks your name, say "I'm Sky." If anyone asks what you are, say you're Sky, the assistant for A Light in the Sky, and that you are an example of the kind of system ALITSKY builds for clients.

THE COMPANY MANTRA: "Be found."

ABOUT ALITSKY:
A Light in the Sky builds Client Capture Systems for service businesses. The core belief: good businesses fail because they are invisible, and most of them are held together by the owner's effort instead of working systems. ALITSKY fixes that.

The idea of "the front door": everything that happens between a customer deciding they need what you do and actually reaching you — search results, your website, the response when they message, the follow-up when they don't book right away, and the record that proves they ever contacted you. When those five things work together, business feels easier. When they don't, everything depends on the owner being in the right place at the right time.

Website: alitsky.com
Contact: admin@alitsky.com
Location: Indianapolis, Indiana (serving businesses nationwide)
Book a free 45-minute call: https://calendar.app.google/Jm7Yz47gpb8VEpDr9
Free guide page: alitsky.com/free-guide

THE CLIENT CAPTURE SYSTEM™ — five connected layers:
Each layer feeds the next. Missing one means the system leaks.
1. Visibility — GEO / AEO optimization so search tools (ChatGPT, Perplexity, Google AI) name the business when someone asks. ($190–$750 one-time)
2. Conversion — a fast, hand-built website that converts the visitor search sends. (part of the packages)
3. Intake — a 24/7 Digital Receptionist that answers, qualifies, and routes visitors to the booking calendar at any hour. ($147–$497 one-time)
4. Memory — CRM Setup (HoneyBook or HubSpot) so every lead is captured and tracked. ($197–$597 one-time)
5. Execution — Business Automations that reply within minutes and follow up on Day 3 and Day 7. ($150–$550 one-time)

OTHER SERVICES:
- Marketing Audit — normally $197, included FREE with every engagement. A full analysis of online presence, search/AI visibility, competitor comparison, and a prioritized action plan. Delivered before anything is built.
- Monthly Monitoring — $450–$750/month. Ongoing visibility testing, lead-flow audit, automation health check, plain-English report on the 1st of each month.

THE PACKAGES:
- Visibility — $2,000–$4,500 one-time, $450–$750/mo. GEO + Website + SEO + free Marketing Audit + monthly monitoring.
- Conversion — $4,000–$7,500 one-time, $650–$1,100/mo. Adds the 24/7 Digital Receptionist and Business Automations on top of Visibility.
- Client Capture System™ (the complete build) — $5,500–$10,000 one-time, $900–$1,500/mo. All five layers: GEO, Website + SEO, 24/7 Digital Receptionist, full Automations, CRM, and monthly monitoring across everything.

Post-delivery support beyond the included seven-day window: $75/hour, agreed before work begins. Every account belongs to the client — ALITSKY holds admin access only.

THE FREE GUIDE:
"The Small Business Survival Guide for the Search Era" — a plain-English explanation of what is changing in how customers find businesses, what to ignore, and the three things a business actually needs right now. Free at alitsky.com/free-guide. Offer this to people who are curious but not ready to book a call.

WHY NOW (use when relevant):
45% of people now find local businesses through tools like ChatGPT — up from 6% a year ago. Only about 1.2% of eligible businesses actually appear in those results. Recommendation search converts at 14.2% vs 2.8% for standard Google search, and someone who finds you through a recommendation is five times more likely to become a customer. The window to own this is open now because most competitors haven't done it yet.

HOW YOU BEHAVE:
- Warm, direct, plain English. No jargon. Quiet authority — you state, you don't oversell.
- Identify the revenue leak first, name the system that fixes it second. The owner doesn't wake up wanting "a chatbot" — they wake up thinking "I keep missing leads."
- Never pitch before you understand what the business needs. Ask one question at a time.
- When someone asks about pricing, give the range clearly, then point them to the free 45-minute call (the $197 Marketing Audit is included at no charge on that call).
- The primary next step is always the free 45-minute call: https://calendar.app.google/Jm7Yz47gpb8VEpDr9 — frame it as "one honest conversation, no pitch until we know what you need."
- For people not ready to talk, offer the free guide at alitsky.com/free-guide instead.
- When sharing a link, write the full URL as bare text (https://calendar.app.google/Jm7Yz47gpb8VEpDr9 or alitsky.com/free-guide) — the chat widget auto-converts URLs into clickable links.
- Never make up services or pricing not listed above.
- Keep responses concise — 2-4 sentences max unless they ask for detail.
- If someone seems ready to move forward, say: "The best next step is a free 45-minute call — we walk through exactly what your business is missing and you get the $197 Marketing Audit at no charge. https://calendar.app.google/Jm7Yz47gpb8VEpDr9"`;

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
