import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

describe("application variants", () => {
  it("isolates OpenNest credentials and validates its native provider API without dropping shared controls", async () => {
    vi.stubEnv("VITE_APP_PROVIDER", "open");
    vi.resetModules();
    const { application } = await import("./application");
    const { ApiClient } = await import("./api");
    const { saveConnectionSettings } = await import("./storage");
    const { translate } = await import("./i18n");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://open.home.arpa", token: "open-secret" });
    expect(application.name).toBe("OpenNest");
    expect(application.agentName).toBe("OpenCode");
    expect(application.capabilities).toMatchObject({
      codexManagement: false,
      rateLimits: false,
      plan: true,
      team: true,
      goal: true,
      forks: true,
      browserIntegration: true,
      fullTextSearch: true,
      skills: true,
      artifacts: true,
    });
    expect(api.webSocketUrl()).toBe("wss://open.home.arpa/api/v1/ui/events");
    await api.health();
    await api.saveOpenKey("sk-or-input");
    await api.readOpenProxy();
    expect((fetchMock.mock.calls[0]![1]!.headers as Headers).get("Authorization")).toBe(
      "Bearer open-secret",
    );
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://open.home.arpa/api/v1/settings/open");
    expect(fetchMock.mock.calls[1]![1]!.body).toBe(JSON.stringify({ apiKey: "sk-or-input" }));
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      "https://open.home.arpa/api/v1/settings/open/proxy",
    );
    await saveConnectionSettings({ baseUrl: "https://open.home.arpa", token: "open-secret" });
    expect(localStorage.getItem("opennest.token")).toBe("open-secret");
    expect(localStorage.getItem("codexnest.token")).toBeNull();
    expect(translate("en", "Подключение к CodexNest")).toBe("Connect to OpenNest");
    expect(translate("en", "{{title}}", { title: "My Codex task" })).toBe("My Codex task");
  });
  it("isolates Gemini sign-in and storage and disables unsupported controls", async () => {
    vi.stubEnv("VITE_APP_PROVIDER", "gemini");
    vi.resetModules();
    const { application } = await import("./application");
    const { ApiClient } = await import("./api");
    const { saveConnectionSettings } = await import("./storage");
    const { translate } = await import("./i18n");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const settings = { baseUrl: "https://gemini.home.arpa", token: "gemini-secret" };
    const api = new ApiClient(settings);
    expect(application.name).toBe("GeminiNest");
    expect(application.supportsKanban).toBe(true);
    expect(application.capabilities).toMatchObject({
      codexManagement: false,
      rateLimits: true,
      plan: false,
      team: false,
      goal: false,
      forks: false,
      appUpdates: true,
      browserIntegration: true,
      fullTextSearch: true,
      skills: true,
      artifacts: true,
    });
    expect(translate("ru", "Лимиты Codex")).toBe("Лимиты Gemini");
    expect(translate("en", "Лимиты Codex")).toBe("Gemini limits");
    expect(api.webSocketUrl()).toBe("wss://gemini.home.arpa/api/v1/ui/events");
    await api.health();
    expect((fetchMock.mock.calls[0]![1]!.headers as Headers).get("Authorization")).toBe(
      "Bearer gemini-secret",
    );
    await api.enqueue("thread", { input: "Addition", deliveryMode: "steer" });
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "https://gemini.home.arpa/api/v1/threads/thread/steer",
    );
    await saveConnectionSettings(settings);
    expect(localStorage.getItem("gemininest.token")).toBe("gemini-secret");
    expect(localStorage.getItem("claudenest.token")).toBeNull();
    expect(localStorage.getItem("codexnest.token")).toBeNull();
    expect(translate("en", "Войти через Google")).toBe("Sign in with Google");
    expect(translate("en", "Подключение к CodexNest")).toBe("Connect to GeminiNest");
  });
  it("preserves the default Codex identity, capabilities, storage and event endpoint", async () => {
    vi.stubEnv("VITE_APP_PROVIDER", "");
    vi.resetModules();
    const { application } = await import("./application");
    const { ApiClient } = await import("./api");
    const { saveConnectionSettings } = await import("./storage");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"status":"ok"}'));
    vi.stubGlobal("fetch", fetchMock);
    const settings = { baseUrl: "https://codex.home.arpa", token: "codex-secret" };
    const api = new ApiClient(settings);
    expect(application.name).toBe("CodexNest");
    expect(Object.values(application.capabilities).every(Boolean)).toBe(true);
    expect(api.webSocketUrl()).toBe("wss://codex.home.arpa/api/v1/events");
    await api.health();
    expect((fetchMock.mock.calls[0]![1]!.headers as Headers).get("Authorization")).toBeNull();
    await api.enqueue("thread", { input: "Codex", deliveryMode: "steer" });
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "https://codex.home.arpa/api/v1/threads/thread/queue",
    );
    await saveConnectionSettings(settings);
    expect(localStorage.getItem("codexnest.token")).toBe("codex-secret");
    expect(localStorage.getItem("claudenest.token")).toBeNull();
  });

  it("isolates Claude credentials and labels, authenticates health, and uses the UI event stream", async () => {
    vi.stubEnv("VITE_APP_PROVIDER", "claude");
    vi.resetModules();
    const { application } = await import("./application");
    const { ApiClient } = await import("./api");
    const { saveConnectionSettings, clearConnectionSettings } = await import("./storage");
    const { translate } = await import("./i18n");
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('{"status":"ok","provider":"claude"}'),
    );
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("codexnest.token", "keep-codex");
    const settings = { baseUrl: "https://claude.home.arpa", token: "claude-secret" };
    const api = new ApiClient(settings);
    expect(application.name).toBe("ClaudeNest");
    expect(application.capabilities.browserIntegration).toBe(true);
    expect(application.capabilities.team).toBe(false);
    expect(application.capabilities.reasoningEffort).toBe(true);
    expect(api.webSocketUrl()).toBe("wss://claude.home.arpa/api/v1/ui/events");
    expect(api.webSocketUrl()).not.toContain("secret");
    await api.health();
    expect((fetchMock.mock.calls[0]![1]!.headers as Headers).get("Authorization")).toBe(
      "Bearer claude-secret",
    );
    await api.enqueue("thread", { input: "Addition", deliveryMode: "steer" });
    await api.enqueue("thread", { input: "Queued", deliveryMode: "queue" });
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "https://claude.home.arpa/api/v1/threads/thread/steer",
    );
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      "https://claude.home.arpa/api/v1/threads/thread/queue",
    );
    await saveConnectionSettings(settings);
    expect(localStorage.getItem("claudenest.token")).toBe("claude-secret");
    expect(translate("en", "Подключение к CodexNest")).toBe("Connect to ClaudeNest");
    expect(translate("ru", "{{title}}", { title: "My Codex task" })).toBe("My Codex task");
    await clearConnectionSettings();
    expect(localStorage.getItem("claudenest.token")).toBeNull();
    expect(localStorage.getItem("codexnest.token")).toBe("keep-codex");
  });
});
