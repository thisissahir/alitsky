// /api/landing-page — Vercel Serverless Function
// Captures the "free landing page in 24 hours" intake from the homepage and
// emails it to the team, with the uploaded logo attached, so the page can be
// built and sent back within the promised window.
//
// Environment variables (shared with the other functions):
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
const MAX_LOGO_B64 = 4.2 * 1024 * 1024; // ~3 MB decoded
const LOGO_TYPES = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];

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

  const field = (k, max) => String(body[k] || "").trim().slice(0, max);
  const business = field("business", 160);
  const email = field("email", 200);
  const phone = field("phone", 40);
  const does = field("does", 200);
  const area = field("area", 200);
  const services = field("services", 1000);
  const goal = field("goal", 40);
  const website = field("website", 300);
  const notes = field("notes", 1500);
  const page = field("page", 300);

  if (!business) return res.status(400).json({ error: "Please add your business name." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Please add a valid email." });
  if (!does) return res.status(400).json({ error: "Tell us what your business does." });
  if (!area) return res.status(400).json({ error: "Tell us your city and service area." });
  if (!services) return res.status(400).json({ error: "List the services to feature." });

  // Optional logo: { name, type, b64 }
  let attachment = null;
  if (body.logo && typeof body.logo === "object" && typeof body.logo.b64 === "string" && body.logo.b64) {
    const b64 = body.logo.b64;
    if (b64.length > MAX_LOGO_B64) {
      return res.status(400).json({ error: "Logo is over 3 MB." });
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) {
      return res.status(400).json({ error: "Logo upload was not readable." });
    }
    const type = String(body.logo.type || "");
    if (!LOGO_TYPES.includes(type)) {
      return res.status(400).json({ error: "Logo must be PNG, JPG, SVG, or WebP." });
    }
    const safeName = String(body.logo.name || "logo")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 100) || "logo";
    attachment = { filename: safeName, content: b64 };
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("Landing-page: RESEND_API_KEY not set");
    return res.status(500).json({ error: "not configured" });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const to = process.env.AUDIT_TO_EMAIL || "admin@alitsky.com";
  const from =
    process.env.AUDIT_FROM_EMAIL ||
    "A Light in the Sky <onboarding@resend.dev>";
  const subject = "FREE LANDING PAGE (24h clock) — " + business;

  const rows = [
    ["Business", business],
    ["Email", email],
    ["Phone", phone],
    ["What they do", does],
    ["City / area", area],
    ["Services to feature", services],
    ["Page goal", goal],
    ["Current site / social", website],
    ["Notes", notes],
    ["Logo", attachment ? "attached (" + attachment.filename + ")" : "none provided"],
    ["From page", page],
  ].filter(([, v]) => v);

  const text = [
    "NEW FREE LANDING PAGE REQUEST — the 24-hour clock starts at receipt of this email.",
    "",
    ...rows.map(([k, v]) => k + ": " + v),
  ].join("\n");

  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;color:#0B2030;line-height:1.55;font-size:15px;max-width:620px;">' +
      '<h2 style="font-size:18px;margin:0 0 4px;letter-spacing:-0.01em;">New free landing page request</h2>' +
      '<div style="font-size:12px;color:#c0392b;font-weight:600;margin-bottom:18px;">The 24-hour clock starts at receipt of this email.</div>' +
      '<table style="border-collapse:collapse;font-size:14px;">' +
      rows
        .map(
          ([k, v]) =>
            '<tr><td style="padding:4px 14px 4px 0;color:#5d7382;vertical-align:top;white-space:nowrap;">' +
            escapeHtml(k) +
            '</td><td style="padding:4px 0;">' +
            escapeHtml(v).replace(/\n/g, "<br>") +
            "</td></tr>"
        )
        .join("") +
      "</table>" +
    "</div>";

  const payload = {
    from,
    to: [to],
    subject,
    replyTo: email,
    text,
    html,
  };
  if (attachment) payload.attachments = [attachment];

  try {
    const { error } = await resend.emails.send(payload);
    if (error) {
      console.error("Landing-page: Resend rejected:", error);
      return res.status(502).json({ error: "send failed" });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Landing-page API error:", err);
    return res.status(500).json({ error: "send failed" });
  }
};

module.exports.config = {
  maxDuration: 15,
};
