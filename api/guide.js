// /api/guide — Vercel Serverless Function
// Receives a Free Guide email-capture POST and emails the lead to the team
// via Resend so they can be added to the guide send list.
//
// Reuses the same Resend env vars as the other endpoints:
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
  if (!email) {
    return res.status(400).json({ error: "Missing email" });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set");
    return res.status(500).json({ error: "Mail is not configured on the server" });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const to = process.env.AUDIT_TO_EMAIL || "admin@alitsky.com";
  const from = process.env.AUDIT_FROM_EMAIL || "A Light in the Sky <onboarding@resend.dev>";

  const subject = "Free Guide Request — " + email;

  const text = [
    "New Free Guide request",
    "",
    "Email: " + email,
    "",
    "Add to the guide send list and send the Search-Era Survival Guide.",
  ].join("\n");

  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;color:#0B2030;line-height:1.5;font-size:15px;">' +
    '<h2 style="font-size:18px;margin:0 0 16px;">New Free Guide request</h2>' +
    '<p style="margin:0 0 8px;"><strong>Email:</strong> <a href="mailto:' + escapeHtml(email) + '">' + escapeHtml(email) + "</a></p>" +
    '<p style="margin:0;color:#5d7382;">Add to the guide send list and send the Search-Era Survival Guide.</p>' +
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
      return res.status(500).json({ error: "Mail provider rejected the message" });
    }
    return res.status(200).json({ ok: true, id: data && data.id });
  } catch (err) {
    console.error("Guide send failed:", err);
    return res.status(500).json({ error: "Could not send the message" });
  }
};
