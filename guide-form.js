/* guide-form.js — handles the Free Guide email-capture form(s).
 *
 * Intercepts submit on any <form data-guide-form>, POSTs the email to
 * /api/guide, and shows an inline confirmation. No redirect — the visitor
 * stays on the page.
 */
(function () {
  var forms = document.querySelectorAll("form[data-guide-form]");
  if (!forms.length) return;

  function isValidEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  forms.forEach(function (form) {
    var submitBtn = form.querySelector('button[type="submit"]');
    var status = form.querySelector("[data-form-status]");
    var input = form.querySelector('input[type="email"]');
    var originalText = submitBtn ? submitBtn.textContent : "";

    function setStatus(msg, isError) {
      if (!status) return;
      status.textContent = msg || "";
      status.classList.toggle("error", !!isError);
    }
    function setBusy(busy) {
      if (!submitBtn) return;
      submitBtn.setAttribute("aria-busy", busy ? "true" : "false");
      submitBtn.disabled = busy;
      submitBtn.textContent = busy ? "Sending…" : originalText;
    }

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      setStatus("", false);
      var email = (input && input.value ? input.value : "").trim();

      if (!isValidEmail(email)) {
        setStatus("Please enter a valid email address.", true);
        return;
      }

      setBusy(true);
      try {
        var res = await fetch("/api/guide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email }),
        });
        if (!res.ok) {
          var detail = "";
          try {
            var body = await res.json();
            detail = body && body.error ? body.error : "";
          } catch (_) {}
          throw new Error(detail || "Server returned " + res.status);
        }
        // Success — inline confirmation, swap the form for the message
        form.innerHTML =
          '<p class="guide-status" style="font-size:15px;color:var(--tl-dk);font-weight:600;">' +
          "Check your inbox. On its way now." +
          "</p>";
      } catch (err) {
        setBusy(false);
        setStatus(
          "Something went wrong. Please try again, or email admin@alitsky.com.",
          true
        );
        if (window.console) console.error("Guide form submit failed:", err);
      }
    });
  });
})();
