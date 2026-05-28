// /api/audit — Vercel Serverless Function
// Receives the audit-form POST, validates it, and emails it to admin@alitsky.com via Resend.
//
// Environment variables (set in Vercel project settings → Environment Variables):
//   RESEND_API_KEY     required — get one from https://resend.com after signup
//   AUDIT_TO_EMAIL     optional — recipient (default: admin@alitsky.com)
//   AUDIT_FROM_EMAIL   optional — sender (default: onboarding@resend.dev until you verify alitsky.com)

const { Resend } = require("resend");

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isValidEmail(s) {
  // Permissive — Resend will reject obvious garbage anyway.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Vercel parses JSON automatically when Content-Type is application/json,
  // but fall back to manual parsing just in case.
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (_) {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }
  body = body || {};

  const businessName = (body.businessName || "").toString().trim();
  const email = (body.email || "").toString().trim();
  const website = (body.website || "").toString().trim();
  const description = (body.description || "").toString().trim();
  const yearsOperating = (body.yearsOperating || "").toString().trim();
  const challenge = (body.challenge || "").toString().trim();

  // Server-side validation (mirrors the client-side check).
  const missing = [];
  if (!businessName) missing.push("businessName");
  if (!email) missing.push("email");
  if (!website) missing.push("website");
  if (!description) missing.push("description");
  if (!yearsOperating) missing.push("yearsOperating");
  if (missing.length) {
    return res
      .status(400)
      .json({ error: "Missing required fields: " + missing.join(", ") });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set");
    return res
      .status(500)
      .json({ error: "Mail is not configured on the server" });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const to = process.env.AUDIT_TO_EMAIL || "admin@alitsky.com";
  const from = process.env.AUDIT_FROM_EMAIL || "A Light in the Sky <onboarding@resend.dev>";

  const subject = "New business analysis request — " + businessName;

  // Plain-text body so it reads cleanly in any client.
  const text = [
    "New business analysis request",
    "",
    "Business name:    " + businessName,
    "Email:            " + email,
    "Website / GBP:    " + website,
    "Years operating:  " + yearsOperating,
    "",
    "What does the business do?",
    description,
    "",
    "Biggest challenge:",
    challenge || "(not provided)",
  ].join("\n");

  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;color:#0B2030;line-height:1.5;font-size:15px;">' +
    '<h2 style="font-size:18px;margin:0 0 16px;">New business analysis request</h2>' +
    '<table style="border-collapse:collapse;width:100%;max-width:600px;">' +
    '<tr><td style="padding:6px 14px 6px 0;color:#5d7382;width:160px;vertical-align:top;">Business name</td><td style="padding:6px 0;"><strong>' + escapeHtml(businessName) + "</strong></td></tr>" +
    '<tr><td style="padding:6px 14px 6px 0;color:#5d7382;vertical-align:top;">Email</td><td style="padding:6px 0;"><a href="mailto:' + escapeHtml(email) + '">' + escapeHtml(email) + "</a></td></tr>" +
    '<tr><td style="padding:6px 14px 6px 0;color:#5d7382;vertical-align:top;">Website / GBP</td><td style="padding:6px 0;">' + escapeHtml(website) + "</td></tr>" +
    '<tr><td style="padding:6px 14px 6px 0;color:#5d7382;vertical-align:top;">Years operating</td><td style="padding:6px 0;">' + escapeHtml(yearsOperating) + "</td></tr>" +
    "</table>" +
    '<h3 style="font-size:14px;margin:22px 0 6px;color:#5d7382;text-transform:uppercase;letter-spacing:0.08em;">What does the business do?</h3>' +
    '<p style="margin:0 0 16px;white-space:pre-wrap;">' + escapeHtml(description) + "</p>" +
    '<h3 style="font-size:14px;margin:22px 0 6px;color:#5d7382;text-transform:uppercase;letter-spacing:0.08em;">Biggest challenge</h3>' +
    '<p style="margin:0;white-space:pre-wrap;">' + escapeHtml(challenge || "(not provided)") + "</p>" +
    "</div>";

  try {
    const { data, error } = await resend.emails.send({
      from: from,
      to: [to],
      replyTo: email,
      subject: subject,
      text: text,
      html: html,
    });
    if (error) {
      console.error("Resend error:", error);
      return res
        .status(500)
        .json({ error: "Mail provider rejected the message" });
    }
    return res.status(200).json({ ok: true, id: data && data.id });
  } catch (err) {
    console.error("Audit send failed:", err);
    return res
      .status(500)
      .json({ error: "Could not send the message" });
  }
};
