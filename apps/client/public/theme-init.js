// Run before the app shell paints, including under the server's script-src 'self' CSP.
(() => {
  let theme = "system";
  try {
    const candidate = localStorage.getItem(
      `${document.documentElement.dataset.application || "codexnest"}.theme`,
    );
    if (candidate === "light" || candidate === "dark") theme = candidate;
  } catch {
    // Storage can be unavailable in hardened webviews; keep the system default.
  }
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = theme === "dark" || (theme === "system" && systemDark) ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.resolvedTheme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "dark" ? "#171817" : "#FFFFFF");
})();
