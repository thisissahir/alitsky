/* contact-form.js — handles submission for <form data-contact-form>.
 *
 * Intercepts submit, POSTs JSON to /api/contact, redirects to /thank-you on
 * success. Shows an inline error if the API or network fails.
 */
(function () {
  const forms = document.querySelectorAll("form[data-contact-form]");
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
        email: (fd.get("email") || "").toString().trim(),
        phone: (fd.get("phone") || "").toString().trim(),
      };

      const missing = [];
      if (!payload.email) missing.push("email");
      if (!payload.phone) missing.push("phone");
      if (missing.length) {
        setStatus("Please fill in: " + missing.join(", ") + ".", true);
        return;
      }

      setBusy(true);

      try {
        const res = await fetch("/api/contact", {
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
        window.location.href = "/thank-you";
      } catch (err) {
        setBusy(false);
        setStatus(
          "Something went wrong sending that. Please try again, or email admin@alitsky.com directly.",
          true
        );
        if (window.console) console.error("Contact form submit failed:", err);
      }
    });
  });
})();
