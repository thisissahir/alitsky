/* nav-dropdown.js
 *
 * Click behaviour for the "How we help" mega-menu in the nav.
 *
 *   - Desktop (hover-capable devices): hover still opens the dropdown via CSS
 *     :hover, click on the trigger ADDITIONALLY toggles a sticky .open state
 *     so the menu stays open if the user moves the mouse away.
 *   - Touch devices: hover doesn't fire, click on the trigger opens/closes
 *     the dropdown.
 *   - Click on any service link closes the dropdown (link navigates anyway).
 *   - Click anywhere outside the dropdown closes it.
 *   - Escape key closes any open dropdown.
 */
(function () {
  const dropdowns = document.querySelectorAll(".nav-dropdown");
  if (!dropdowns.length) return;

  dropdowns.forEach((dropdown) => {
    const trigger = dropdown.querySelector(".nav-dropdown-trigger");
    if (!trigger) return;

    trigger.addEventListener("click", (e) => {
      // Always preventDefault so the trigger acts as a menu opener, not a link.
      // The dropdown items themselves are the real navigation.
      e.preventDefault();
      // Close other dropdowns first (in case multiple ever coexist)
      dropdowns.forEach((d) => {
        if (d !== dropdown) d.classList.remove("open");
      });
      dropdown.classList.toggle("open");
    });

    // Clicking any link inside the menu closes it (link navigates away).
    dropdown.querySelectorAll(".nav-mega-item").forEach((link) => {
      link.addEventListener("click", () => {
        dropdown.classList.remove("open");
      });
    });
  });

  // Click anywhere outside closes all dropdowns
  document.addEventListener("click", (e) => {
    dropdowns.forEach((dropdown) => {
      if (!dropdown.contains(e.target)) {
        dropdown.classList.remove("open");
      }
    });
  });

  // Escape closes any open dropdown
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      dropdowns.forEach((d) => d.classList.remove("open"));
    }
  });
})();
