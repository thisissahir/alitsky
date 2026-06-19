// /api/contact — Vercel Serverless Function
// Receives a contact / human-handoff request from the Gloria chat widget and
// emails it to the team via Resend.
//
// Environment variables (shared with /api/chat):
//   RESEND_API_KEY    required
//   AUDIT_TO_EMAIL    optional — defaults to admin@alitsky.com
//   AUDIT_FROM_EMAIL  optional — defaults to a Resend test sender

const { Resend } = require("resend");

// ---- Rate limit (in-memory, per function instance) ----
const RATE_LIMIT = 10;
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (isRateLimited(clientIp(req))) {
    return res.status(429).json({
      error: "Too many requests. Please email admin@alitsky.com directly.",
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
  body = body || {};

  const name = String(body.name || "").trim().slice(0, 120);
  const email = String(body.email || "").trim().slice(0, 200);
  const phone = String(body.phone || "").trim().slice(0, 60);
  const message = String(body.message || "").trim().slice(0, 4000);
  const conversation = Array.isArray(body.conversation) ? body.conversation : [];

  if (!name) return res.status(400).json({ error: "Please add your name." });
  if (!EMAIL_RE.test(email))
    return res.status(400).json({ error: "Please add a valid email." });

  if (!process.env.RESEND_API_KEY) {
    console.error("Contact: RESEND_API_KEY not set");
    return res
      .status(500)
      .json({ error: "Contact form is not configured. Email admin@alitsky.com." });
  }

  // Build a readable transcript for context (capped).
  const transcriptPlain = conversation
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => (m.role === "user" ? "Visitor" : "Gloria") + ": " + m.content)
    .join("\n\n")
    .slice(0, 12000);

  const resend = new Resend(process.env.RESEND_API_KEY);
  const to = process.env.AUDIT_TO_EMAIL || "admin@alitsky.com";
  const from =
    process.env.AUDIT_FROM_EMAIL ||
    "A Light in the Sky <onboarding@resend.dev>";
  const subject = "New contact request from the website chat — " + name;

  const text = [
    "NEW CONTACT / HUMAN HANDOFF REQUEST (from the Gloria chat widget)",
    "",
    "Name:  " + name,
    "Email: " + email,
    phone ? "Phone: " + phone : "Phone: (not provided)",
    "",
    "Message:",
    message || "(none)",
    "",
    "--- CHAT TRANSCRIPT ---",
    transcriptPlain || "(no prior messages)",
  ].join("\n");

  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;color:#0B2030;line-height:1.55;font-size:15px;max-width:640px;">' +
      '<h2 style="font-size:18px;margin:0 0 14px;letter-spacing:-0.01em;">New contact request from the chat</h2>' +
      '<table style="border-collapse:collapse;font-size:14px;margin-bottom:18px;">' +
        '<tr><td style="padding:3px 14px 3px 0;color:#5d7382;">Name</td><td style="padding:3px 0;font-weight:600;">' + escapeHtml(name) + "</td></tr>" +
        '<tr><td style="padding:3px 14px 3px 0;color:#5d7382;">Email</td><td style="padding:3px 0;"><a href="mailto:' + escapeHtml(email) + '">' + escapeHtml(email) + "</a></td></tr>" +
        (phone ? '<tr><td style="padding:3px 14px 3px 0;color:#5d7382;">Phone</td><td style="padding:3px 0;">' + escapeHtml(phone) + "</td></tr>" : "") +
      "</table>" +
      (message
        ? '<h3 style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#137F8E;margin:0 0 6px;">Message</h3><div style="white-space:pre-wrap;margin-bottom:18px;">' + escapeHtml(message) + "</div>"
        : "") +
      '<h3 style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#137F8E;margin:0 0 8px;">Chat transcript</h3>' +
      '<div style="border-left:3px solid #eef6f8;padding:6px 0 6px 14px;white-space:pre-wrap;font-size:13px;color:#33424c;">' + escapeHtml(transcriptPlain || "(no prior messages)") + "</div>" +
    "</div>";

  try {
    const { error } = await resend.emails.send({
      from,
      to: [to],
      subject,
      replyTo: email,
      text,
      html,
    });
    if (error) {
      console.error("Contact: Resend rejected:", error);
      return res
        .status(502)
        .json({ error: "Could not send right now. Email admin@alitsky.com." });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Contact API error:", err);
    return res
      .status(500)
      .json({ error: "Could not send right now. Email admin@alitsky.com." });
  }
};

module.exports.config = {
  maxDuration: 15,
};
