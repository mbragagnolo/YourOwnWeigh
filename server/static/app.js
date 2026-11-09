document.addEventListener("click", (event) => {
  const reveal = event.target.closest("[data-reveal-secret]");
  if (reveal) {
    const secret = document.getElementById(reveal.dataset.revealSecret);
    if (secret) {
      secret.hidden = false;
      reveal.hidden = true;
    }
    return;
  }
  const open = event.target.closest("[data-open-dialog]");
  if (open) {
    const dialog = document.getElementById(open.dataset.openDialog);
    if (dialog && !dialog.open) dialog.showModal();
    return;
  }
  const close = event.target.closest("[data-close-dialog]");
  if (close) {
    close.closest("dialog")?.close();
    return;
  }
  const tab = event.target.closest("[data-tab-target]");
  if (tab) {
    const group = tab.closest("[data-tab-group]");
    if (!group) return;
    const scope = group.closest("dialog") || group.parentElement;
    group.querySelectorAll("[data-tab-target]").forEach((button) => {
      button.setAttribute("aria-selected", String(button === tab));
    });
    scope.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      panel.hidden = panel.id !== tab.dataset.tabTarget;
    });
  }
});

document.addEventListener("submit", (event) => {
  const message = event.target.dataset.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});

document
  .querySelectorAll("dialog[data-auto-open]")
  .forEach((dialog) => dialog.showModal());

const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
// A user's own zone is offered first as a duplicate. The disabled divider keeps
// the complete alphabetical IANA list easy to scan, including a saved old alias.
document.querySelectorAll("select[data-timezone-select]").forEach((select) => {
  const saved = select.dataset.selectedZone;
  const current = browserTimeZone || "UTC";
  const zones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [
          "UTC",
          "Europe/Berlin",
          "Europe/London",
          "America/New_York",
          "America/Los_Angeles",
          "Asia/Tokyo",
          "Australia/Sydney",
        ];
  const all = [
    ...new Set(["UTC", current, ...(saved ? [saved] : []), ...zones]),
  ].sort();
  select.replaceChildren(
    new Option(`${current.replaceAll("_", " ")} (Your Time Zone)`, current),
  );
  const divider = new Option("──────────", "");
  divider.disabled = true;
  select.add(divider);
  for (const zone of all)
    select.add(new Option(zone.replaceAll("_", " "), zone));
  select.value = saved || current;
});
if (browserTimeZone) {
  document.querySelectorAll("input[data-browser-timezone]").forEach((input) => {
    if (!input.value) input.value = browserTimeZone;
  });
}

// Reused setup/settings checkbox disclosure; no inline scripts are necessary.
document.querySelectorAll("[data-toggle]").forEach((toggle) => {
  const refresh = () => {
    const panel = document.getElementById(toggle.dataset.toggle);
    if (panel) panel.hidden = !toggle.checked;
  };
  toggle.addEventListener("change", refresh);
  refresh();
});

// Metric pickers and chart toggles remain ordinary GET forms without JavaScript.
document.addEventListener("change", (event) => {
  if (
    (event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLInputElement) &&
    event.target.matches("[data-submit-on-change]")
  )
    event.target.form.requestSubmit();
});

// Chart markers: one styled tooltip instead of the native <title>, which
// stays in the markup for when JavaScript is unavailable.
document.querySelectorAll(".chart-svg .dot").forEach((dot) => {
  dot.querySelector("title")?.remove();
  dot.setAttribute("tabindex", "0");
  dot.setAttribute("aria-label", dot.dataset.tip);
});
const showTip = (dot) => {
  const figure = dot.closest(".chart");
  if (!figure) return;
  const tip =
    figure.querySelector(".chart-tip") ||
    figure.appendChild(Object.assign(document.createElement("div"), { className: "chart-tip" }));
  const box = dot.getBoundingClientRect(),
    frame = figure.getBoundingClientRect();
  tip.textContent = dot.dataset.tip;
  tip.style.left = `${box.left + box.width / 2 - frame.left}px`;
  tip.style.top = `${box.top - frame.top}px`;
  tip.hidden = false;
};
const hideTip = (dot) => {
  const tip = dot.closest(".chart")?.querySelector(".chart-tip");
  if (tip) tip.hidden = true;
};
for (const [show, hide] of [["pointerover", "pointerout"], ["focusin", "focusout"]]) {
  document.addEventListener(show, (event) => {
    const dot = event.target.closest?.(".chart-svg .dot");
    if (dot) showTip(dot);
  });
  document.addEventListener(hide, (event) => {
    const dot = event.target.closest?.(".chart-svg .dot");
    if (dot) hideTip(dot);
  });
}
