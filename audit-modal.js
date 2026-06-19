/* audit-modal.js — A Light in the Sky
 *
 * When a visitor clicks any "free audit" CTA (a link to the Google Calendar
 * booking page), show a small modal asking for their business name + email,
 * capture that lead, then send them on to the calendar.
 *
 * Self-contained vanilla JS. Loaded sitewide alongside chatbot.js.
 */
(function () {
  if (window.__alitskyAuditModalLoaded) return;
  window.__alitskyAuditModalLoaded = true;

  var CAL_URL = "https://calendar.app.google/Jm7Yz47gpb8VEpDr9";
  // Any link pointing at the booking calendar is an "audit" CTA.
  var SELECTOR = 'a[href*="calendar.app.google/Jm7Yz47gpb8VEpDr9"]';
  var LEAD_KEY = "alitskyAuditLead_v1";
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function alreadyCaptured() {
    try { return sessionStorage.getItem(LEAD_KEY) === "1"; } catch (_) { return false; }
  }
  function markCaptured() {
    try { sessionStorage.setItem(LEAD_KEY, "1"); } catch (_) {}
  }

  // -------- Styles --------
  var style = document.createElement("style");
  style.textContent = [
    ".alsy-am-overlay{position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;padding:20px;",
      "background:rgba(7,21,30,0.62);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);",
      "opacity:0;transition:opacity 180ms ease;font-family:'Sora',system-ui,-apple-system,sans-serif;}",
    ".alsy-am-overlay.is-open{display:flex;opacity:1;}",
    ".alsy-am-card{width:100%;max-width:430px;background:#ffffff;border-radius:18px;",
      "box-shadow:0 40px 80px -24px rgba(7,21,30,0.55),0 8px 24px rgba(7,21,30,0.18);",
      "padding:30px 30px 26px;transform:translateY(14px) scale(0.985);transition:transform 200ms cubic-bezier(0.22,1,0.36,1);",
      "position:relative;box-sizing:border-box;}",
    ".alsy-am-overlay.is-open .alsy-am-card{transform:translateY(0) scale(1);}",
    ".alsy-am-card *{box-sizing:border-box;}",
    ".alsy-am-close{position:absolute;top:14px;right:14px;width:32px;height:32px;border:0;background:transparent;",
      "color:#7A9298;cursor:pointer;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:background 120ms,color 120ms;}",
    ".alsy-am-close:hover{background:rgba(11,32,48,0.06);color:#0B2030;}",
    ".alsy-am-close svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;}",
    ".alsy-am-badge{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;letter-spacing:0.14em;",
      "text-transform:uppercase;color:#0E4858;margin-bottom:12px;}",
    ".alsy-am-badge svg{width:15px;height:15px;}",
    ".alsy-am-title{font-size:23px;line-height:1.18;font-weight:700;letter-spacing:-0.01em;color:#0B2030;margin:0 0 8px;}",
    ".alsy-am-sub{font-size:14.5px;line-height:1.55;color:#4a5f6b;margin:0 0 20px;}",
    ".alsy-am-field{display:block;margin-bottom:12px;}",
    ".alsy-am-label{display:block;font-size:12.5px;font-weight:600;color:#33424c;margin-bottom:5px;}",
    ".alsy-am-input{width:100%;font:400 15px/1.4 'Sora',system-ui,sans-serif;color:#0B2030;background:#F7FAFA;",
      "border:1px solid #E5E7EB;border-radius:10px;padding:12px 13px;outline:none;transition:border-color 140ms,box-shadow 140ms;}",
    ".alsy-am-input::placeholder{color:#9BB0BB;}",
    ".alsy-am-input:focus{border-color:#0E4858;box-shadow:0 0 0 3px rgba(14,72,88,0.10);}",
    ".alsy-am-error{font-size:12.5px;color:#c0392b;margin:-4px 0 10px;min-height:1px;}",
    ".alsy-am-submit{width:100%;margin-top:4px;background:#e0531f;color:#fff;border:0;border-radius:10px;padding:14px 18px;",
      "font:700 15px 'Sora',system-ui,sans-serif;letter-spacing:0.03em;cursor:pointer;display:inline-flex;align-items:center;",
      "justify-content:center;gap:9px;transition:background 140ms,transform 140ms;}",
    ".alsy-am-submit:hover:not(:disabled){background:#c8471a;}",
    ".alsy-am-submit:active:not(:disabled){transform:translateY(1px);}",
    ".alsy-am-submit:disabled{opacity:0.6;cursor:default;}",
    ".alsy-am-note{display:flex;align-items:center;gap:8px;justify-content:center;font-size:12.5px;color:#7A9298;margin-top:14px;text-align:center;}",
    ".alsy-am-note svg{width:15px;height:15px;flex:none;}",
    "@media (max-width:480px){.alsy-am-card{padding:26px 22px 22px;border-radius:16px;}.alsy-am-title{font-size:21px;}}"
  ].join("");
  document.head.appendChild(style);

  // -------- DOM --------
  var overlay = document.createElement("div");
  overlay.className = "alsy-am-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Start your free audit");
  overlay.innerHTML =
    '<div class="alsy-am-card">' +
      '<button class="alsy-am-close" type="button" aria-label="Close">' +
        '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      "</button>" +
      '<div class="alsy-am-badge">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="#0E4858" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6Z"/><path d="M9 11.5l2 2 4-4.5"/></svg>' +
        "Free audit &middot; No obligation" +
      "</div>" +
      '<h2 class="alsy-am-title">Start your free audit</h2>' +
      '<p class="alsy-am-sub">Tell us where to send your audit, then pick a time on the next screen. It is free and there is no obligation.</p>' +
      '<form class="alsy-am-form" autocomplete="on" novalidate>' +
        '<label class="alsy-am-field"><span class="alsy-am-label">Business name</span>' +
          '<input class="alsy-am-input alsy-am-business" type="text" name="organization" placeholder="e.g. Cool Breeze HVAC" autocomplete="organization" /></label>' +
        '<label class="alsy-am-field"><span class="alsy-am-label">Email</span>' +
          '<input class="alsy-am-input alsy-am-email" type="email" name="email" placeholder="you@business.com" autocomplete="email" inputmode="email" /></label>' +
        '<div class="alsy-am-error" hidden></div>' +
        '<button class="alsy-am-submit" type="submit">Continue to booking <span aria-hidden="true">&#8594;</span></button>' +
      "</form>" +
      '<div class="alsy-am-note">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="#7A9298" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V8a5 5 0 0 1 10 0v3"/></svg>' +
        "We email your audit here. No spam, ever." +
      "</div>" +
    "</div>";
  document.body.appendChild(overlay);

  var card = overlay.querySelector(".alsy-am-card");
  var form = overlay.querySelector(".alsy-am-form");
  var businessEl = overlay.querySelector(".alsy-am-business");
  var emailEl = overlay.querySelector(".alsy-am-email");
  var errEl = overlay.querySelector(".alsy-am-error");
  var submitEl = overlay.querySelector(".alsy-am-submit");
  var closeEl = overlay.querySelector(".alsy-am-close");

  var lastFocus = null;

  function openModal() {
    lastFocus = document.activeElement;
    submitEl.disabled = false; // reset in case it was disabled by a prior submit
    clearErr();
    overlay.classList.add("is-open");
    document.addEventListener("keydown", onKeydown, true);
    setTimeout(function () { try { businessEl.focus(); } catch (_) {} }, 60);
  }
  function closeModal() {
    overlay.classList.remove("is-open");
    document.removeEventListener("keydown", onKeydown, true);
    clearErr();
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (_) {} }
  }
  function onKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); closeModal(); }
  }
  function showErr(m) { errEl.textContent = m; errEl.hidden = false; }
  function clearErr() { errEl.hidden = true; errEl.textContent = ""; }

  function goToCalendar() {
    // Open synchronously inside the user gesture so it isn't popup-blocked.
    var w = window.open(CAL_URL, "_blank", "noopener");
    if (!w) window.location.href = CAL_URL; // fallback if blocked
  }

  function handleSubmit() {
    clearErr();
    var business = businessEl.value.trim();
    var email = emailEl.value.trim();
    if (!business) { showErr("Please add your business name."); businessEl.focus(); return; }
    if (!EMAIL_RE.test(email)) { showErr("Please add a valid email address."); emailEl.focus(); return; }

    // 1) Send them to the calendar right away (keeps the user gesture intact).
    goToCalendar();

    // 2) Capture the lead in the background (don't block the booking on it).
    try {
      fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business: business, email: email, page: location.pathname }),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}

    markCaptured();
    submitEl.disabled = true;
    closeModal();
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); handleSubmit(); });
  closeEl.addEventListener("click", closeModal);
  overlay.addEventListener("mousedown", function (e) {
    if (e.target === overlay) closeModal(); // click the backdrop to dismiss
  });

  // -------- Intercept audit CTAs --------
  document.addEventListener(
    "click",
    function (e) {
      var link = e.target.closest && e.target.closest(SELECTOR);
      if (!link) return;
      // Let links inside the chat widget behave normally (the chat has its own flow).
      if (link.closest(".alsy-chat-root")) return;
      // Once we've captured this session, go straight to the calendar.
      if (alreadyCaptured()) return;
      e.preventDefault();
      openModal();
    },
    true
  );
})();
