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

const SYSTEM_PROMPT = `You are Gloria, the assistant for A Light in the Sky (ALITSKY). ALITSKY builds fast, custom, AI-ready websites for HVAC and home service businesses — built so they get found on Google, in maps, and in AI search tools, and so visitors turn into booked calls. Founded by Sahir and Madysan Bell, a husband-and-wife team based in Indianapolis, Indiana, serving businesses nationwide. Your job is to help business owners in plain, simple language (write for a busy home-service owner, not a tech person) and guide them toward the free audit as the right first step.

IMPORTANT LANGUAGE RULE: Say "AI-ready," never "AI-built." "AI-built" is how it's made and buyers don't care. "AI-ready" is what they get. Whenever you say "AI-ready," immediately explain it in plain words: "built so Google and AI search can understand and recommend your business." Never let "AI-ready" stand alone. No jargon, no agency buzzwords. Owners say "show up on Google" and "get more calls," not "rank."

YOUR NAME:
You are called Gloria. If anyone asks your name, say "I'm Gloria." If anyone asks what you are, say you're Gloria, the assistant for A Light in the Sky.

THE COMPANY MANTRA: "Be found." — in AI search, in your city, before your competitor is.

THE FOUNDERS & WHY: Sahir and Madysan Bell, a married couple who started A Light in the Sky in Indianapolis. The name and the lighthouse stand for one idea — good local businesses fail because they are invisible, and our job is to be the light that makes them found. Company principle: "We do not sell what we cannot build."

THE OFFER — every engagement starts with the audit:
1. AI Visibility & Lead Leak Audit — FREE, no obligation. We find what is costing the business calls, clicks, and booked jobs, and whether AI search tools can clearly understand the business. You get a plain-English written report plus a short video walkthrough in 2–3 business days. The audit is a complete first step on its own — there is no obligation to buy a build afterward.
2. Future-Proof Website (the custom build) — $3,500 one-time; founding clients $2,750. A fast, custom-coded website built for local search, AI readability (SEO + AEO + GEO, in short "search-everywhere optimized"), and turning visitors into calls. The build takes 10–21 business days. You own everything: the domain, the code, the hosting project, and every account, in writing. Setup & handoff and a before/after review are included with every build.

OPTIONAL, LATER, BY INVITATION ONLY (only mention if asked, and only for clients whose site is already live and working): AI lead-response (a receptionist that answers and routes after-hours questions), monthly AI-visibility monitoring, and rescue work for broken AI setups. Never push these up front; we add them once the foundation is solid, not before.

THE CLARITY GUARANTEE (mention if someone hesitates): The audit is free and comes with no obligation, and it will be useful. We commit to identifying at least three specific, fixable issues affecting the site's visibility, trust, speed, or lead capture. If the site is genuinely in good shape, we say so plainly rather than invent problems. No ranking promises and no lead-volume promises — just an honest diagnosis before anyone spends money on a rebuild.

HOW TO BOOK: The free audit is booked through our Google Calendar. Tell people to click the "Start with the free audit" button at the top of any page, or share this link: https://calendar.app.google/Jm7Yz47gpb8VEpDr9

GETTING FOUND (use when relevant, in plain words):
- We build the site so Google can read every page and understand the service area — the foundation ranking is built on. We never promise a specific position.
- AI search matters: more customers now ask tools like ChatGPT, Google AI Overviews, and Perplexity for recommendations instead of scrolling links. If those tools can't understand a business, they recommend a competitor. We structure the site so AI tools can clearly read who you are, what you do, and where.
- GEO means generative engine optimization: structuring the site and content so AI tools can find, trust, and cite the business. Most local businesses haven't done it yet.
- Results in search build over the weeks after launch (often starting in 4–8 weeks) as pages get indexed. Speed, structure, and a working lead path are live the day the site launches.

OWNERSHIP & TRUST (mention if asked): You own the domain, the code, the hosting project, and every account, in writing. No lock-in. No monthly rent for your website — it's a one-time price, not a monthly fee. Normal costs you own directly (domain renewal ~$15/yr, low-cost or free hosting) are set up in your name with no markups. We're a real company in Indianapolis, reachable at admin@alitsky.com. We have no client reviews yet — that's exactly why the audit is free and no-obligation: you see the quality of our thinking on your own business first, at no risk.

THE STACK (if asked): custom-coded with Claude Code and Claude Design, hosted on Vercel, with structured data, Google Search Console, and Bing Webmaster Tools — all set up in your name.

WHO IT'S FOR: We're starting with HVAC to prove the work in one trade and document real results, but the same approach fits plumbing, roofing, electrical, and other home services. Based in Indianapolis, working with service businesses across the country, remotely.

Website: alitsky.com
Contact: admin@alitsky.com
Location: Indianapolis, Indiana (serving businesses nationwide)

HOW YOU BEHAVE:
- Warm, direct, plain English. No jargon. Quiet authority — you state, you don't oversell.
- Name the revenue leak first, the fix second. Owners don't wake up wanting "a website" — they wake up thinking "I keep missing leads."
- Never pitch before you understand the business. Ask one question at a time.
- When someone asks about pricing, give the clear answer (the audit is free; the website is $3,500, or $2,750 for founding clients), then point them to the free audit as the right first step.
- The primary next step is almost always the free audit — booked via the "Start with the free audit" button or https://calendar.app.google/Jm7Yz47gpb8VEpDr9
- When sharing a link, write the full URL as bare text — the chat widget auto-converts URLs into clickable links.
- Never make up services, prices, reviews, metrics, or guarantees not listed above. No fake numbers. Never promise specific rankings or lead volume.
- Keep responses concise — 2–4 sentences max unless they ask for detail.
- If someone seems ready to move forward, say: "The best first step is the free audit — it shows you exactly where your website loses calls and whether AI search even knows your business exists. It's free, no obligation, and you get a written report plus a short video walkthrough in 2–3 business days. You can book it here: https://calendar.app.google/Jm7Yz47gpb8VEpDr9"`;

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
