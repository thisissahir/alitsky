/* services-accordion.js
 *
 * Wires up the "How we help" accordion on the homepage.
 *
 *   - One row open at a time
 *   - Click the open row's header again to close it
 *   - Smooth height transition (measured from scrollHeight so any copy length works)
 *   - Re-measures on window resize so an open row stays sized correctly when wrap changes
 *   - aria-expanded and aria-controls are kept in sync for screen readers
 */
(function () {
  const rows = document.querySelectorAll(".service-row");
  if (!rows.length) return;

  function panelOf(row) {
    return row.querySelector(".service-expand");
  }
  function innerOf(row) {
    return row.querySelector(".service-expand-inner");
  }
  function btnOf(row) {
    return row.querySelector(".service-row-head");
  }

  function close(row) {
    if (!row.classList.contains("open")) return;
    row.classList.remove("open");
    btnOf(row).setAttribute("aria-expanded", "false");
    panelOf(row).style.maxHeight = "0px";
  }

  function open(row) {
    row.classList.add("open");
    btnOf(row).setAttribute("aria-expanded", "true");
    // scrollHeight of the inner gives us the natural height of the content
    panelOf(row).style.maxHeight = innerOf(row).scrollHeight + "px";
  }

  rows.forEach((row) => {
    btnOf(row).addEventListener("click", () => {
      const wasOpen = row.classList.contains("open");
      // close every other row first
      rows.forEach((r) => {
        if (r !== row) close(r);
      });
      // toggle this row
      if (wasOpen) close(row);
      else open(row);
    });
  });

  // If the window resizes while a row is open, recompute its target height —
  // otherwise wrapped content can be clipped or leave empty space.
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const openRow = document.querySelector(".service-row.open");
      if (openRow) {
        panelOf(openRow).style.maxHeight =
          innerOf(openRow).scrollHeight + "px";
      }
    }, 120);
  });
})();
