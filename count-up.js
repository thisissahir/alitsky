/* count-up.js — animate .count elements when they scroll into view.
 *
 * Usage in markup:
 *   <span class="count" data-target="42" data-format="int" data-duration="1400">0</span>
 *
 * Supported data-format values:
 *   "int"        — integer (e.g. 142)
 *   "decimal-1"  — one decimal place (e.g. 1.4)
 *   "time-ms"    — formats total seconds as "Xm Ys" (e.g. 107 -> "1m 47s")
 *
 * Each element animates only once, the first time it crosses 40% into the viewport.
 * Respects prefers-reduced-motion: snaps to final value instead of animating.
 */
(function () {
  const counters = document.querySelectorAll(".count");
  if (!counters.length) return;

  const formatters = {
    int: (n) => String(Math.round(n)),
    "decimal-1": (n) => (Math.round(n * 10) / 10).toFixed(1),
    "time-ms": (n) => {
      const total = Math.round(n);
      const m = Math.floor(total / 60);
      const s = total % 60;
      return m + "m " + s + "s";
    },
  };

  const fmt = (el) => formatters[el.dataset.format] || formatters.int;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  // Reduced-motion: skip animation, jump straight to final values.
  if (
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    counters.forEach((el) => {
      const target = parseFloat(el.dataset.target);
      el.textContent = fmt(el)(target);
    });
    return;
  }

  function animate(el) {
    const target = parseFloat(el.dataset.target);
    const format = fmt(el);
    const duration = parseInt(el.dataset.duration, 10) || 1400;
    const start = performance.now();

    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      const value = target * easeOutCubic(t);
      el.textContent = format(value);
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // Fallback for ancient browsers without IntersectionObserver.
  if (typeof IntersectionObserver === "undefined") {
    counters.forEach(animate);
    return;
  }

  const seen = new WeakSet();
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !seen.has(entry.target)) {
          seen.add(entry.target);
          animate(entry.target);
        }
      });
    },
    { threshold: 0.4 }
  );

  counters.forEach((el) => observer.observe(el));
})();
