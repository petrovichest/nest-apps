// Floating CodexNest window for another site.
// Usage on the host page:
//   <script src="https://codexnest.example/embed.js"></script>
//   CodexNestEmbed.open({ src: "https://codexnest.example/", title: "CodexNest" });
// The server must list the host page origin in CODEXNEST_EMBED_ORIGINS, otherwise
// the browser refuses to show the application inside the frame.
(() => {
  if (window.CodexNestEmbed) return;

  const STORAGE_KEY = "codexnest.embed.window";
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 320;
  const MARGIN = 8;
  const NARROW = 640;
  const EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

  const STYLE = `
    :host { all: initial; }
    .window {
      position: fixed; z-index: 2147483000; display: flex; flex-direction: column; box-sizing: border-box;
      border-radius: 16px; overflow: hidden; background: var(--bg); color: var(--ink);
      border: 1px solid var(--line); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
      font: 500 13px/1.25 "Onest", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .window[hidden], .bubble[hidden] { display: none; }
    .window.maximized, .window.narrow { border-radius: 0; border: 0; }
    .bar {
      flex: none; display: flex; align-items: center; gap: 4px; height: 36px; padding: 0 6px 0 12px;
      cursor: move; user-select: none; touch-action: none; border-bottom: 1px solid var(--line);
    }
    .window.maximized .bar, .window.narrow .bar { cursor: default; }
    .grip { display: flex; gap: 2px; opacity: 0.55; }
    .grip i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; display: block; }
    .grip span { display: grid; gap: 2px; }
    .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
    button {
      all: unset; box-sizing: border-box; display: grid; place-items: center; width: 28px; height: 28px;
      border-radius: 8px; color: var(--muted); cursor: pointer;
    }
    button[hidden] {
      display: none;
    }
    button:hover { background: var(--hover); color: var(--ink); }
    button:focus-visible { outline: 2px solid var(--muted); outline-offset: -2px; }
    svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8;
      stroke-linecap: round; stroke-linejoin: round; }
    .frame { flex: 1; width: 100%; border: 0; background: var(--canvas); }
    .shield { position: absolute; inset: 36px 0 0; display: none; }
    .window.busy .shield { display: block; }
    .edge { position: absolute; z-index: 1; touch-action: none; }
    .window.maximized .edge, .window.narrow .edge { display: none; }
    .edge.n, .edge.s { left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
    .edge.e, .edge.w { top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
    .edge.n { top: 0; } .edge.s { bottom: 0; } .edge.e { right: 0; } .edge.w { left: 0; }
    .edge.ne, .edge.nw, .edge.se, .edge.sw { width: 14px; height: 14px; }
    .edge.ne { top: 0; right: 0; cursor: nesw-resize; } .edge.sw { bottom: 0; left: 0; cursor: nesw-resize; }
    .edge.nw { top: 0; left: 0; cursor: nwse-resize; } .edge.se { bottom: 0; right: 0; cursor: nwse-resize; }
    .bubble {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; display: flex; align-items: center; gap: 8px;
      width: auto; height: 44px; padding: 0 16px; border-radius: 22px; background: var(--bg); color: var(--ink);
      border: 1px solid var(--line); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
      font: 600 13px/1 "Onest", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .bubble:hover { background: var(--hover); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #4b9ce8; }
  `;
  const THEMES = {
    light: {
      bg: "#f8f9f6",
      canvas: "#ffffff",
      ink: "#292a29",
      muted: "#646660",
      line: "#e5e5e1",
      hover: "#e2e5dc",
    },
    dark: {
      bg: "#242722",
      canvas: "#171817",
      ink: "#e9eae7",
      muted: "#b1b4ae",
      line: "#323431",
      hover: "#2a2e28",
    },
  };
  const ICON = {
    minimize: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
    maximize: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>',
    restore:
      '<svg viewBox="0 0 24 24"><rect x="5" y="8" width="11" height="11" rx="2.5"/><path d="M9 5h7.5A2.5 2.5 0 0 1 19 7.5V15"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };

  let host = null;
  let root = null;
  let win = null;
  let frame = null;
  let bubble = null;
  let options = {};
  let geometry = null;
  let maximized = false;
  let themeQuery = null;

  function readGeometry() {
    try {
      const saved = JSON.parse(localStorage.getItem(options.storageKey || STORAGE_KEY) || "null");
      if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) {
        maximized = saved.maximized === true;
        return { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
      }
    } catch {
      // Ignore unavailable or corrupt storage and use the default placement.
    }
    const width = Math.min(1000, Math.max(MIN_WIDTH, window.innerWidth - 2 * MARGIN));
    const height = Math.min(760, Math.max(MIN_HEIGHT, window.innerHeight - 2 * MARGIN));
    return {
      x: window.innerWidth - width - 24,
      y: Math.max(MARGIN, (window.innerHeight - height) / 2),
      width,
      height,
    };
  }

  function saveGeometry() {
    try {
      localStorage.setItem(
        options.storageKey || STORAGE_KEY,
        JSON.stringify({ ...geometry, maximized }),
      );
    } catch {
      // Placement simply resets next time.
    }
  }

  // Keep the whole window, or at least its title bar, reachable after the viewport shrinks.
  function clamp(next) {
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - 2 * MARGIN);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - 2 * MARGIN);
    const width = Math.min(Math.max(next.width, MIN_WIDTH), maxWidth);
    const height = Math.min(Math.max(next.height, MIN_HEIGHT), maxHeight);
    const x = Math.min(
      Math.max(next.x, MARGIN),
      Math.max(MARGIN, window.innerWidth - width - MARGIN),
    );
    const y = Math.min(
      Math.max(next.y, MARGIN),
      Math.max(MARGIN, window.innerHeight - height - MARGIN),
    );
    return { x, y, width, height };
  }

  function layout() {
    const narrow = window.innerWidth < NARROW;
    win.classList.toggle("narrow", narrow);
    win.classList.toggle("maximized", maximized && !narrow);
    const full = narrow || maximized;
    const box = full
      ? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
      : geometry;
    win.style.left = `${box.x}px`;
    win.style.top = `${box.y}px`;
    win.style.width = `${box.width}px`;
    win.style.height = `${box.height}px`;
    const toggle = root.querySelector('[data-action="maximize"]');
    toggle.innerHTML = maximized ? ICON.restore : ICON.maximize;
    toggle.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
    toggle.title = maximized ? "Restore" : "Maximize";
    toggle.hidden = narrow;
  }

  function applyTheme() {
    const theme =
      options.theme === "light" || options.theme === "dark"
        ? options.theme
        : themeQuery && themeQuery.matches
          ? "dark"
          : "light";
    for (const [name, value] of Object.entries(THEMES[theme]))
      host.style.setProperty(`--${name}`, value);
  }

  // One pointer gesture moves or resizes the window. The shield keeps the frame
  // from swallowing pointer events while the gesture is in progress.
  function track(event, update) {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = { px: event.clientX, py: event.clientY, ...geometry };
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    win.classList.add("busy");
    const move = (moveEvent) => {
      geometry = clamp(update(start, moveEvent.clientX - start.px, moveEvent.clientY - start.py));
      layout();
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      win.classList.remove("busy");
      saveGeometry();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  function resizeBy(edge, start, dx, dy) {
    let { x, y, width, height } = start;
    if (edge.includes("e")) width = start.width + dx;
    if (edge.includes("s")) height = start.height + dy;
    if (edge.includes("w")) {
      width = Math.max(MIN_WIDTH, start.width - dx);
      x = start.x + start.width - width;
    }
    if (edge.includes("n")) {
      height = Math.max(MIN_HEIGHT, start.height - dy);
      y = start.y + start.height - height;
    }
    return { x, y, width, height };
  }

  function build() {
    host = document.createElement("div");
    host.setAttribute("data-codexnest-embed", "");
    root = host.attachShadow({ mode: "open" });
    const title = options.title || "CodexNest";
    root.innerHTML = `
      <style>${STYLE}</style>
      <section class="window" role="dialog" aria-label="${escapeHtml(title)}">
        <header class="bar">
          <span class="grip" aria-hidden="true"><span><i></i><i></i><i></i></span><span><i></i><i></i><i></i></span></span>
          <span class="title">${escapeHtml(title)}</span>
          <button type="button" data-action="minimize" aria-label="Minimize" title="Minimize">${ICON.minimize}</button>
          <button type="button" data-action="maximize"></button>
          <button type="button" data-action="close" aria-label="Close" title="Close">${ICON.close}</button>
        </header>
        <iframe class="frame" title="${escapeHtml(title)}" allow="clipboard-read; clipboard-write; microphone"></iframe>
        <div class="shield"></div>
        ${EDGES.map((edge) => `<div class="edge ${edge}" data-edge="${edge}"></div>`).join("")}
      </section>
      <button class="bubble" type="button" hidden><span class="dot"></span>${escapeHtml(title)}</button>`;
    win = root.querySelector(".window");
    frame = root.querySelector(".frame");
    bubble = root.querySelector(".bubble");

    const bar = root.querySelector(".bar");
    bar.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button") || maximized || window.innerWidth < NARROW) return;
      track(event, (start, dx, dy) => ({ ...start, x: start.x + dx, y: start.y + dy }));
    });
    bar.addEventListener("dblclick", (event) => {
      if (!event.target.closest("button")) toggleMaximized();
    });
    for (const edge of root.querySelectorAll(".edge")) {
      edge.addEventListener("pointerdown", (event) =>
        track(event, (start, dx, dy) => resizeBy(edge.dataset.edge, start, dx, dy)),
      );
    }
    root.querySelector('[data-action="minimize"]').addEventListener("click", minimize);
    root.querySelector('[data-action="maximize"]').addEventListener("click", toggleMaximized);
    root.querySelector('[data-action="close"]').addEventListener("click", close);
    bubble.addEventListener("click", show);
    window.addEventListener("resize", () => {
      geometry = clamp(geometry);
      layout();
    });
    themeQuery = window.matchMedia?.("(prefers-color-scheme: dark)") || null;
    themeQuery?.addEventListener?.("change", applyTheme);
    document.body.appendChild(host);
  }

  function toggleMaximized() {
    maximized = !maximized;
    layout();
    saveGeometry();
  }

  function show() {
    win.hidden = false;
    bubble.hidden = true;
    layout();
  }

  function minimize() {
    win.hidden = true;
    bubble.hidden = false;
  }

  // Closing hides the window without unloading the application, so a running
  // session keeps streaming and reopening is instant.
  function close() {
    win.hidden = true;
    bubble.hidden = true;
    options.onClose?.();
  }

  function open(next = {}) {
    const firstOpen = !host;
    options = { ...options, ...next };
    if (!options.src) throw new Error("CodexNestEmbed.open requires src");
    if (firstOpen) {
      build();
      geometry = clamp(readGeometry());
    }
    applyTheme();
    if (frame.dataset.src !== options.src) {
      frame.dataset.src = options.src;
      frame.src = options.src;
    }
    show();
  }

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
    );
  }

  window.CodexNestEmbed = {
    open,
    close: () => host && close(),
    minimize: () => host && minimize(),
    isOpen: () => Boolean(host && !win.hidden),
    setTheme(theme) {
      options.theme = theme;
      if (host) applyTheme();
    },
  };
})();
