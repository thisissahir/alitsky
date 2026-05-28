// /api/contact — Vercel Serverless Function
// Receives the "Talk to us" contact form (email + phone), emails it to
// admin@alitsky.com via Resend. Pairs with the form on /contact.
//
// Reuses the same Resend env vars as /api/audit:
//   RESEND_API_KEY     required
//   AUDIT_TO_EMAIL     optional — recipient (default: admin@alitsky.com)
//   AUDIT_FROM_EMAIL   optional — sender   (default: onboarding@resend.dev)

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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
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

  const email = (body.email || "").toString().trim();
  const phone = (body.phone || "").toString().trim();

  const missing = [];
  if (!email) missing.push("email");
  if (!phone) missing.push("phone");
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

  const subject = "New contact — " + email;

  const text = [
    "New contact request",
    "",
    "Email:  " + email,
    "Phone:  " + phone,
  ].join("\n");

  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;color:#0B2030;line-height:1.5;font-size:15px;">' +
    '<h2 style="font-size:18px;margin:0 0 16px;">New contact request</h2>' +
    '<table style="border-collapse:collapse;width:100%;max-width:600px;">' +
    '<tr><td style="padding:6px 14px 6px 0;color:#5d7382;width:90px;vertical-align:top;">Email</td><td style="padding:6px 0;"><a href="mailto:' + escapeHtml(email) + '">' + escapeHtml(email) + "</a></td></tr>" +
    '<tr><td style="padding:6px 14px 6px 0;color:#5d7382;vertical-align:top;">Phone</td><td style="padding:6px 0;"><a href="tel:' + escapeHtml(phone) + '">' + escapeHtml(phone) + "</a></td></tr>" +
    "</table>" +
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
    console.error("Contact send failed:", err);
    return res
      .status(500)
      .json({ error: "Could not send the message" });
  }
};
