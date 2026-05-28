/* audit-form.js — handles submission for any <form data-audit-form>.
 *
 * Intercepts submit, POSTs JSON to /api/audit, redirects to /thank-you on
 * success. Shows inline error if the API or network fails.
 *
 * Works with the audit form on /audit and the embedded form on /services/analysis.
 */
(function () {
  const forms = document.querySelectorAll("form[data-audit-form]");
  if (!forms.length) return;

  forms.forEach((form) => {
    const submitBtn = form.querySelector('button[type="submit"]');
    const status = form.querySelector("[data-form-status]");
    const originalBtnText = submitBtn ? submitBtn.textContent : "";

    function setStatus(msg, isError) {
      if (!status) return;
      status.textContent = msg || "";
      status.classList.toggle("error", !!isError);
    }

    function setBusy(busy) {
      if (!submitBtn) return;
      submitBtn.setAttribute("aria-busy", busy ? "true" : "false");
      submitBtn.disabled = busy;
      submitBtn.textContent = busy ? "Sending…" : originalBtnText;
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      setStatus("", false);

      const fd = new FormData(form);
      const payload = {
        businessName: (fd.get("businessName") || "").toString().trim(),
        email: (fd.get("email") || "").toString().trim(),
        website: (fd.get("website") || "").toString().trim(),
        description: (fd.get("description") || "").toString().trim(),
        yearsOperating: (fd.get("yearsOperating") || "").toString().trim(),
        challenge: (fd.get("challenge") || "").toString().trim(),
      };

      // Client-side required check (HTML validation handles most of this,
      // but belt and braces for users who disable it).
      const missing = [];
      if (!payload.businessName) missing.push("business name");
      if (!payload.email) missing.push("email");
      if (!payload.website) missing.push("website / Google Business link");
      if (!payload.description) missing.push("what your business does");
      if (!payload.yearsOperating) missing.push("years operating");
      if (missing.length) {
        setStatus("Please fill in: " + missing.join(", ") + ".", true);
        return;
      }

      setBusy(true);

      try {
        const res = await fetch("/api/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          let detail = "";
          try {
            const body = await res.json();
            detail = body && body.error ? body.error : "";
          } catch (_) {}
          throw new Error(detail || ("Server returned " + res.status));
        }
        // Success — redirect.
        window.location.href = "/thank-you";
      } catch (err) {
        setBusy(false);
        setStatus(
          "Something went wrong sending that. Please try again, or email admin@alitsky.com directly.",
          true
        );
        // Log for debugging in the browser console.
        if (window.console) console.error("Audit form submit failed:", err);
      }
    });
  });
})();
