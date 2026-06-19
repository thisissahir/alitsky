// /api/lead — Vercel Serverless Function
// Captures a free-audit lead (business name + email) when someone clicks an
// audit CTA, before they are sent to the Google Calendar booking page.
// Emails the lead to the team via Resend so it is captured even if the
// visitor does not finish booking.
//
// Environment variables (shared with /api/chat and /api/contact):
//   RESEND_API_KEY    required
//   AUDIT_TO_EMAIL    optional — defaults to admin@alitsky.com
//   AUDIT_FROM_EMAIL  optional — defaults to a Resend test sender

const { Resend } = require("resend");

// ---- Rate limit (in-memory, per function instance) ----
const RATE_LIMIT = 15;
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
    return res.status(429).json({ error: "Too many requests." });
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

  const business = String(body.business || "").trim().slice(0, 160);
  const email = String(body.email || "").trim().slice(0, 200);
  const page = String(body.page || "").trim().slice(0, 300);

  if (!business) return res.status(400).json({ error: "Please add your business name." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Please add a valid email." });

  if (!process.env.RESEND_API_KEY) {
    console.error("Lead: RESEND_API_KEY not set");
    // Don't block the booking on our side — report soft failure.
    return res.status(500).json({ error: "not configured" });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const to = process.env.AUDIT_TO_EMAIL || "admin@alitsky.com";
  const from =
    process.env.AUDIT_FROM_EMAIL ||
    "A Light in the Sky <onboarding@resend.dev>";
  const subject = "New free-audit lead — " + business;

  const text = [
    "NEW FREE-AUDIT LEAD (clicked an audit CTA, headed to the calendar)",
    "",
    "Business: " + business,
    "Email:    " + email,
    page ? "From page: " + page : "",
  ].filter(Boolean).join("\n");

  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;color:#0B2030;line-height:1.55;font-size:15px;max-width:560px;">' +
      '<h2 style="font-size:18px;margin:0 0 4px;letter-spacing:-0.01em;">New free-audit lead</h2>' +
      '<div style="font-size:12px;color:#5d7382;margin-bottom:18px;">Clicked an audit button and was sent to the booking calendar.</div>' +
      '<table style="border-collapse:collapse;font-size:14px;">' +
        '<tr><td style="padding:3px 14px 3px 0;color:#5d7382;">Business</td><td style="padding:3px 0;font-weight:600;">' + escapeHtml(business) + "</td></tr>" +
        '<tr><td style="padding:3px 14px 3px 0;color:#5d7382;">Email</td><td style="padding:3px 0;"><a href="mailto:' + escapeHtml(email) + '">' + escapeHtml(email) + "</a></td></tr>" +
        (page ? '<tr><td style="padding:3px 14px 3px 0;color:#5d7382;">Page</td><td style="padding:3px 0;">' + escapeHtml(page) + "</td></tr>" : "") +
      "</table>" +
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
      console.error("Lead: Resend rejected:", error);
      return res.status(502).json({ error: "send failed" });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Lead API error:", err);
    return res.status(500).json({ error: "send failed" });
  }
};

module.exports.config = {
  maxDuration: 15,
};
