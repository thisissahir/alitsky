// /api/scan — Vercel Serverless Function
// Runs a real AI-visibility (AEO/GEO) check on a visitor-supplied website:
//   1. captures the lead (business + email + target URL) to admin@alitsky.com
//   2. SSRF-safely fetches the page + robots.txt and extracts concrete signals
//   3. derives pass/partial/missing status for 6 dimensions
//   4. streams Gloria's plain-English evaluation of the real findings
//
// Wire format of the streamed response:
//   <SOH>{findings json}<SOH>\n   (first line — control char \x01 delimits it)
//   ...Gloria's prose...          (the rest)
//
// Environment variables (shared with the other functions):
//   ANTHROPIC_API_KEY  required
//   RESEND_API_KEY     optional — lead email is skipped if missing
//   AUDIT_TO_EMAIL / AUDIT_FROM_EMAIL  optional

const AnthropicLib = require("@anthropic-ai/sdk");
const Anthropic = AnthropicLib.default || AnthropicLib;
const { Resend } = require("resend");
const dns = require("dns").promises;

// ---- Rate limit (in-memory, per instance) ----
const RATE_LIMIT = 8;
const WINDOW_MS = 60 * 60 * 1000;
const buckets = new Map();
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}
function isRateLimited(ip) {
  const now = Date.now();
  const e = buckets.get(ip);
  if (!e || now > e.resetAt) { buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS }); return false; }
  e.count += 1;
  return e.count > RATE_LIMIT;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- SSRF protection ----
function ipIsPrivate(ip) {
  ip = String(ip).toLowerCase();
  if (ip.indexOf(":") !== -1) {
    // IPv6
    if (ip === "::1" || ip === "::") return true;
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // unique local
    if (ip.startsWith("fe80")) return true; // link-local
    if (ip.startsWith("::ffff:")) return ipIsPrivate(ip.split(":").pop());
    return false;
  }
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}
function hostLooksInternal(host) {
  host = String(host).toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan")
  );
}
async function assertSafeUrl(u) {
  const parsed = new URL(u);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http and https are supported.");
  if (parsed.port && !["", "80", "443"].includes(parsed.port)) throw new Error("That port is not allowed.");
  if (hostLooksInternal(parsed.hostname)) throw new Error("That address is not allowed.");
  if (ipIsPrivate(parsed.hostname)) throw new Error("That address is not allowed.");
  // Resolve and re-check the IP (covers public hostnames pointing at private IPs).
  try {
    const records = await dns.lookup(parsed.hostname, { all: true });
    for (const r of records) if (ipIsPrivate(r.address)) throw new Error("That address is not allowed.");
  } catch (e) {
    if (/not allowed/.test(e.message)) throw e;
    throw new Error("We could not resolve that domain.");
  }
  return parsed;
}

async function readCapped(resp, maxBytes) {
  if (!resp.body || !resp.body.getReader) {
    const t = await resp.text();
    return t.slice(0, maxBytes);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let out = "", total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    out += dec.decode(value, { stream: true });
    if (total >= maxBytes) { try { reader.cancel(); } catch (_) {} break; }
  }
  return out;
}

// Fetch with manual redirect-following, re-validating each hop.
async function safeFetch(rawUrl, opts) {
  opts = opts || {};
  let current = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    await assertSafeUrl(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 8000);
    let resp;
    try {
      resp = await fetch(current, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "User-Agent": "ALITSKY-AIVisibilityCheck/1.0 (+https://www.alitsky.com)",
          "Accept": opts.accept || "text/html,application/xhtml+xml",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
      current = new URL(resp.headers.get("location"), current).toString();
      continue;
    }
    return { resp, finalUrl: current };
  }
  throw new Error("Too many redirects.");
}

// ---- Analysis ----
function stripToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function attr(tag, name) {
  const re = new RegExp(name + '\\s*=\\s*"([^"]*)"', "i");
  const m = tag.match(re);
  if (m) return m[1];
  const re2 = new RegExp(name + "\\s*=\\s*'([^']*)'", "i");
  const m2 = tag.match(re2);
  return m2 ? m2[1] : "";
}
function metaContent(html, key, isProperty) {
  const a = isProperty ? "property" : "name";
  const re = new RegExp('<meta[^>]*' + a + '\\s*=\\s*["\']' + key + '["\'][^>]*>', "i");
  const m = html.match(re);
  if (!m) return "";
  return attr(m[0], "content").trim();
}
function collectSchemaTypes(html) {
  const types = new Set();
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch (_) { continue; }
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node["@type"]) {
        const t = node["@type"];
        (Array.isArray(t) ? t : [t]).forEach((x) => types.add(String(x)));
      }
      if (node["@graph"]) walk(node["@graph"]);
    };
    walk(data);
  }
  return Array.from(types);
}

function parseRobots(txt) {
  // returns { blocksAi: [bots], allowsAi: bool, sitemap: bool }
  const lines = String(txt).split(/\r?\n/);
  const aiBots = ["gptbot", "oai-searchbot", "chatgpt-user", "claudebot", "anthropic-ai", "perplexitybot", "google-extended"];
  let curAgents = [];
  const disallowAll = {}; // agent -> true if Disallow: /
  let sitemap = false;
  for (let raw of lines) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (field === "user-agent") { curAgents = [val.toLowerCase()]; }
    else if (field === "disallow") {
      if (val === "/") curAgents.forEach((a) => { disallowAll[a] = true; });
    } else if (field === "sitemap") { sitemap = true; }
  }
  const blocked = [];
  aiBots.forEach((b) => { if (disallowAll[b] || disallowAll["*"]) blocked.push(b); });
  return { blocked, sitemap };
}

const DIMENSION_LABELS = {
  crawlable: "AI crawlers can read your site",
  identity: "Clear business identity",
  schema: "Structured data (schema)",
  answers: "Answer-ready content",
  local: "Local signals (name, phone, area)",
  basics: "Findability basics",
};

async function analyze(targetUrl) {
  const out = { reachable: false, url: targetUrl, domain: "", dimensions: [], facts: {} };
  let html = "", finalUrl = targetUrl, status = 0, parsedUrl = null;
  try {
    parsedUrl = new URL(targetUrl);
    out.domain = parsedUrl.hostname.replace(/^www\./, "");
    const { resp, finalUrl: fu } = await safeFetch(targetUrl, { timeout: 8000 });
    finalUrl = fu;
    status = resp.status;
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (status >= 200 && status < 400 && ct.indexOf("html") !== -1) {
      html = await readCapped(resp, 700 * 1024);
      out.reachable = true;
    } else if (status >= 200 && status < 400) {
      html = await readCapped(resp, 200 * 1024);
      out.reachable = true;
    }
  } catch (e) {
    out.error = e.message || "fetch failed";
  }

  // robots.txt (best effort)
  let robots = { blocked: [], sitemap: false };
  let robotsFetched = false;
  if (parsedUrl) {
    try {
      const { resp } = await safeFetch(parsedUrl.origin + "/robots.txt", { timeout: 5000, accept: "text/plain" });
      if (resp.status >= 200 && resp.status < 300) {
        const rtxt = await readCapped(resp, 120 * 1024);
        robots = parseRobots(rtxt);
        robotsFetched = true;
      }
    } catch (_) {}
  }

  if (!out.reachable) {
    out.https = parsedUrl ? parsedUrl.protocol === "https:" : false;
    out.facts = { fetchError: out.error || "Could not load the page." };
    return out;
  }

  const lowerHtml = html.toLowerCase();
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].replace(/\s+/g, " ").trim();
  const metaDesc = metaContent(html, "description", false);
  const ogTitle = metaContent(html, "og:title", true);
  const ogDesc = metaContent(html, "og:description", true);
  const ogImage = metaContent(html, "og:image", true);
  const hasViewport = /<meta[^>]*name\s*=\s*["']viewport["']/i.test(html);
  const hasCanonical = /<link[^>]*rel\s*=\s*["']canonical["']/i.test(html);
  const h1s = (html.match(/<h1[\s\S]*?<\/h1>/gi) || []).map((h) => stripToText(h)).filter(Boolean);
  const headings = (html.match(/<h[1-3][\s\S]*?<\/h[1-3]>/gi) || []).map((h) => stripToText(h));
  const questionHeadings = headings.filter((h) => /\?\s*$/.test(h)).length;
  const schemaTypes = collectSchemaTypes(html);
  const typeSet = new Set(schemaTypes.map((t) => t.toLowerCase()));
  const localTypes = ["localbusiness", "hvacbusiness", "plumber", "electrician", "roofingcontractor", "homeandconstructionbusiness", "professionalservice", "generalcontractor"];
  const hasLocalBiz = localTypes.some((t) => typeSet.has(t));
  const hasOrg = typeSet.has("organization") || hasLocalBiz;
  const hasFaqSchema = typeSet.has("faqpage");
  const phone = /href\s*=\s*["']tel:/i.test(html) || /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(stripToText(html).slice(0, 6000));
  const hasAddress = /\b\d{1,5}\s+[A-Za-z0-9.\s]{3,30}\b(?:street|st|avenue|ave|road|rd|blvd|boulevard|drive|dr|lane|ln|way|suite|ste)\b/i.test(html) || /\b\d{5}(?:-\d{4})?\b/.test(stripToText(html).slice(0, 8000));
  const text = stripToText(html);
  const wordCount = text ? text.split(/\s+/).length : 0;
  const scriptCount = (html.match(/<script\b/gi) || []).length;
  const looksSpa = /<div[^>]+id\s*=\s*["'](root|app|__next|__nuxt)["']/i.test(html);
  const jsDependent = wordCount < 130 && (looksSpa || scriptCount >= 8);
  const aiBlocked = robots.blocked.length > 0;
  const sitemap = robots.sitemap;
  const https = (parsedUrl && parsedUrl.protocol === "https:") || finalUrl.indexOf("https://") === 0;

  // ---- derive dimensions ----
  function dim(key, status, detail) { out.dimensions.push({ key: key, label: DIMENSION_LABELS[key], status: status, detail: detail }); }

  // 1. crawlable
  if (jsDependent || aiBlocked) {
    dim("crawlable", "missing",
      jsDependent ? "Your main content seems to load with JavaScript, which many AI tools cannot read."
                  : "Your robots file blocks AI crawlers (" + robots.blocked.join(", ") + ").");
  } else if (wordCount < 250) {
    dim("crawlable", "partial", "There is not much readable text on the page for AI tools to understand you (" + wordCount + " words).");
  } else {
    dim("crawlable", "pass", "Your page text is readable without JavaScript, and AI crawlers are not blocked.");
  }

  // 2. identity
  if (title && (metaDesc || ogDesc)) dim("identity", "pass", "You have a clear page title and description AI tools can use.");
  else if (title) dim("identity", "partial", "You have a title but no meta description, so tools have less to work with.");
  else dim("identity", "missing", "No clear page title or description was found.");

  // 3. schema
  if (hasLocalBiz) dim("schema", "pass", "You have LocalBusiness structured data — exactly what AI and Google read to understand a local business.");
  else if (schemaTypes.length) dim("schema", "partial", "You have some structured data (" + schemaTypes.slice(0, 4).join(", ") + ") but no LocalBusiness markup.");
  else dim("schema", "missing", "No structured data (schema) was found, so machines have to guess what your business is.");

  // 4. answers
  if (hasFaqSchema) dim("answers", "pass", "You have FAQ structured data, which helps you show up as the direct answer.");
  else if (questionHeadings >= 2) dim("answers", "partial", "You answer some questions on the page, but without FAQ schema to mark them up.");
  else dim("answers", "missing", "No question-and-answer content was found that AI tools can quote.");

  // 5. local
  if ((phone && (hasAddress || hasLocalBiz))) dim("local", "pass", "Your phone and location details are present for local search.");
  else if (phone) dim("local", "partial", "A phone number is present, but the service area or address is unclear.");
  else dim("local", "missing", "No clear phone number or service-area details were found.");

  // 6. basics
  const basicsHits = [https, sitemap, hasCanonical, hasViewport].filter(Boolean).length;
  const basicsMissing = [];
  if (!https) basicsMissing.push("HTTPS");
  if (!sitemap) basicsMissing.push("a sitemap");
  if (!hasCanonical) basicsMissing.push("a canonical tag");
  if (!hasViewport) basicsMissing.push("a mobile viewport tag");
  if (basicsHits === 4) dim("basics", "pass", "HTTPS, sitemap, canonical, and mobile basics are all in place.");
  else if (basicsHits >= 2) dim("basics", "partial", "Some basics are covered. Missing: " + basicsMissing.join(", ") + ".");
  else dim("basics", "missing", "Several findability basics are missing: " + basicsMissing.join(", ") + ".");

  out.facts = {
    title, metaDesc: metaDesc || ogDesc, schemaTypes, hasFaqSchema, hasLocalBiz, phone, hasAddress,
    wordCount, jsDependent, aiBlocked, aiBlockedBots: robots.blocked, sitemap, https, hasCanonical, hasViewport,
    questionHeadings, h1: h1s[0] || "", robotsFetched, ogImage: !!ogImage, finalUrl,
  };
  return out;
}

function summary(out) {
  const strong = out.dimensions.filter((d) => d.status === "pass").length;
  return { strong, total: out.dimensions.length };
}

// Compact text the model reads.
function findingsForModel(out, business) {
  if (!out.reachable) {
    return "Business: " + business + "\nWebsite: " + out.url + "\nRESULT: We could not load the site (" + (out.facts.fetchError || "unreachable") + "). Give brief, general guidance and invite them to the free audit so a human can look.";
  }
  const s = summary(out);
  let lines = [];
  lines.push("Business: " + business);
  lines.push("Website: " + out.domain);
  lines.push("Strong dimensions: " + s.strong + " of " + s.total);
  lines.push("");
  out.dimensions.forEach((d) => { lines.push("- " + d.label + " [" + d.status.toUpperCase() + "]: " + d.detail); });
  lines.push("");
  lines.push("Key facts: schema types = " + (out.facts.schemaTypes.length ? out.facts.schemaTypes.join(", ") : "none") +
    "; FAQ schema = " + out.facts.hasFaqSchema + "; LocalBusiness schema = " + out.facts.hasLocalBiz +
    "; AI crawlers blocked = " + (out.facts.aiBlocked ? out.facts.aiBlockedBots.join(", ") : "no") +
    "; content words = " + out.facts.wordCount + "; JS-dependent content = " + out.facts.jsDependent +
    "; phone present = " + out.facts.phone + "; sitemap = " + out.facts.sitemap + "; https = " + out.facts.https + ".");
  return lines.join("\n");
}

const SCAN_SYSTEM = `You are Gloria, the assistant for A Light in the Sky (ALITSKY). A visitor entered their website and we ran a real, automated AI-visibility check on it (we actually fetched the page and robots file and looked at concrete signals). You are given the findings. Write a short, plain-English evaluation for a busy service business owner who is not technical.

Structure your reply exactly like this (use these short headers on their own lines):
The short version
<one honest sentence on how ready their site is for AI search and Google right now>

What is working
<1 to 3 short bullet points starting with "- ", only if there is something genuinely positive in the findings>

What is costing you visibility
<1 to 3 short bullet points starting with "- ">

Top 3 fixes
<a numbered list, 1 to 3 items, the most important first, specific to THESE findings>

Rules: base everything ONLY on the findings given. Never invent numbers, scores, rankings, or guarantees. Never promise a position on Google or in ChatGPT. Plain words only — if you mention AEO or GEO, explain them in a few words. Be encouraging but honest. Keep the whole thing under about 180 words. End with one warm sentence inviting them to start the free audit, where we go deeper and can do the fixes for them.`;

function statusColor(s) { return s === "pass" ? "#1f9d57" : (s === "partial" ? "#c98a1e" : "#d8491f"); }
function dimLineText(d) { return "- " + d.label + " [" + d.status.toUpperCase() + "]: " + d.detail; }

// Email the full review (lead details + findings + Gloria's write-up) to the
// team so they can forward it to the potential lead.
async function sendReview(business, email, url, findings, reviewText) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("scan: RESEND_API_KEY not set — skipping review email");
    return;
  }
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const to = process.env.AUDIT_TO_EMAIL || "admin@alitsky.com";
    const from = process.env.AUDIT_FROM_EMAIL || "A Light in the Sky <onboarding@resend.dev>";
    const domain = findings.domain || url;
    const reachable = !!findings.reachable;
    const s = reachable ? summary(findings) : null;

    let dimsHtml = "";
    if (reachable && Array.isArray(findings.dimensions)) {
      dimsHtml = findings.dimensions.map(function (d) {
        return (
          '<tr><td style="padding:6px 12px 6px 0;vertical-align:top;white-space:nowrap;">' +
            '<span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;color:#fff;background:' + statusColor(d.status) + ';border-radius:5px;padding:2px 7px;">' + d.status.toUpperCase() + "</span></td>" +
          '<td style="padding:6px 0;"><strong>' + escapeHtml(d.label) + "</strong><br>" +
            '<span style="color:#5a6f7b;font-size:13px;">' + escapeHtml(d.detail) + "</span></td></tr>"
        );
      }).join("");
    }
    const reviewHtml = reviewText ? escapeHtml(reviewText).replace(/\n/g, "<br>") : "(The written review was not generated.)";

    const html =
      '<div style="font-family:system-ui,sans-serif;color:#0B2030;font-size:15px;line-height:1.55;max-width:640px;">' +
        '<h2 style="font-size:19px;margin:0 0 4px;">AI-visibility review — ' + escapeHtml(business) + "</h2>" +
        '<div style="font-size:12px;color:#5d7382;margin-bottom:18px;">Ready to send to the lead.</div>' +
        '<table style="font-size:14px;border-collapse:collapse;margin-bottom:18px;">' +
          '<tr><td style="padding:3px 14px 3px 0;color:#5d7382;">Business</td><td style="padding:3px 0;font-weight:600;">' + escapeHtml(business) + "</td></tr>" +
          '<tr><td style="padding:3px 14px 3px 0;color:#5d7382;">Email</td><td style="padding:3px 0;"><a href="mailto:' + escapeHtml(email) + '">' + escapeHtml(email) + "</a></td></tr>" +
          '<tr><td style="padding:3px 14px 3px 0;color:#5d7382;">Checked</td><td style="padding:3px 0;">' + escapeHtml(url) + "</td></tr>" +
          (s ? '<tr><td style="padding:3px 14px 3px 0;color:#5d7382;">Result</td><td style="padding:3px 0;">' + s.strong + " of " + s.total + " areas strong</td></tr>" : "") +
        "</table>" +
        (reachable
          ? '<h3 style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#137F8E;margin:0 0 8px;">The checks</h3><table style="border-collapse:collapse;margin-bottom:20px;">' + dimsHtml + "</table>"
          : '<p style="color:#b4521f;">We could not load the site: ' + escapeHtml((findings.facts && findings.facts.fetchError) || "unreachable") + "</p>") +
        '<h3 style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#137F8E;margin:0 0 8px;">Gloria’s review (what the visitor saw)</h3>' +
        '<div style="border-left:3px solid #eef6f8;padding:6px 0 6px 14px;white-space:pre-wrap;">' + reviewHtml + "</div>" +
      "</div>";

    const text =
      "AI-VISIBILITY REVIEW — " + business + "\nReady to send to the lead.\n\n" +
      "Business: " + business + "\nEmail: " + email + "\nChecked: " + url +
      (s ? "\nResult: " + s.strong + " of " + s.total + " areas strong" : "") + "\n\n" +
      (reachable && Array.isArray(findings.dimensions)
        ? "THE CHECKS:\n" + findings.dimensions.map(dimLineText).join("\n") + "\n\n"
        : "(Site could not be loaded.)\n\n") +
      "GLORIA'S REVIEW:\n" + (reviewText || "(not generated)");

    await resend.emails.send({
      from, to: [to], replyTo: email,
      subject: "AI-visibility review — " + business + " (" + domain + ")",
      text, html,
    });
  } catch (e) {
    console.error("scan: review email failed:", e && e.message);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  if (isRateLimited(clientIp(req))) return res.status(429).json({ error: "You have run a few checks already. Please try again later, or email admin@alitsky.com." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { return res.status(400).json({ error: "Invalid JSON body" }); } }
  body = body || {};
  const business = String(body.business || "").trim().slice(0, 160);
  const email = String(body.email || "").trim().slice(0, 200);
  let url = String(body.url || "").trim().slice(0, 400);

  if (!business) return res.status(400).json({ error: "Please add your business name." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Please add a valid email." });
  if (!url) return res.status(400).json({ error: "Please add your website address." });
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try { new URL(url); } catch (_) { return res.status(400).json({ error: "That does not look like a valid website address." }); }

  if (!process.env.ANTHROPIC_API_KEY) { console.error("scan: ANTHROPIC_API_KEY not set"); return res.status(500).json({ error: "The check is not configured yet. Email admin@alitsky.com." }); }

  // Pre-validate the URL is safe before doing anything heavy.
  try { await assertSafeUrl(url); }
  catch (e) { return res.status(400).json({ error: e.message || "That website address cannot be checked." }); }

  // analyze
  let findings;
  try { findings = await analyze(url); }
  catch (e) { findings = { reachable: false, url: url, domain: "", dimensions: [], facts: { fetchError: e.message || "error" } }; }

  // 3) stream: findings JSON line, then Gloria's prose
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  const clientFindings = {
    domain: findings.domain || (function () { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return url; } })(),
    reachable: findings.reachable,
    dimensions: findings.dimensions,
    summary: findings.reachable ? summary(findings) : null,
    error: findings.reachable ? null : (findings.facts && findings.facts.fetchError) || "Could not load the site.",
  };
  res.write("\x01" + JSON.stringify(clientFindings) + "\x01\n");

  let reviewText = "";
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const stream = await client.messages.stream({
      model: "claude-sonnet-4-5",
      max_tokens: 700,
      system: SCAN_SYSTEM,
      messages: [{ role: "user", content: "Here are the findings from the AI-visibility check:\n\n" + findingsForModel(findings, business) }],
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta && event.delta.type === "text_delta") {
        res.write(event.delta.text);
        reviewText += event.delta.text;
      }
    }
    res.end();
  } catch (err) {
    console.error("scan: Claude error:", err && err.message);
    if (!res.writableEnded) { try { res.write("\n\nI could not finish the written summary, but your results above are real. Start the free audit and we will walk you through them."); res.end(); } catch (_) {} }
  }

  // After the visitor has their results, email the full review (lead + findings
  // + Gloria's write-up) to the team so they can forward it to the lead.
  try { await sendReview(business, email, url, findings, reviewText); } catch (_) {}
};

module.exports.config = { maxDuration: 45 };
