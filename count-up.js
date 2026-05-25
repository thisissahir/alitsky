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
 * Optional data attributes:
 *   data-snap    — final string to display once the count finishes
 *                  (e.g. data-snap="800M+" snaps after the number reaches 800)
 *   data-delay   — ms to wait after the element enters the viewport before
 *                  starting (used to stagger a row of counters)
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

  const finalText = (el) => {
    if (el.dataset.snap) return el.dataset.snap;
    return fmt(el)(parseFloat(el.dataset.target));
  };

  // Reduced-motion: skip animation, jump straight to final values.
  if (
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    counters.forEach((el) => {
      el.textContent = finalText(el);
    });
    return;
  }

  function animate(el) {
    const target = parseFloat(el.dataset.target);
    const format = fmt(el);
    const duration = parseInt(el.dataset.duration, 10) || 1400;
    const delay = parseInt(el.dataset.delay, 10) || 0;
    const snap = el.dataset.snap;

    function run() {
      const start = performance.now();
      function tick(now) {
        const t = Math.min((now - start) / duration, 1);
        const value = target * easeOutCubic(t);
        el.textContent = format(value);
        if (t < 1) {
          requestAnimationFrame(tick);
        } else if (snap) {
          el.textContent = snap;
        }
      }
      requestAnimationFrame(tick);
    }

    if (delay > 0) {
      setTimeout(run, delay);
    } else {
      run();
    }
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
