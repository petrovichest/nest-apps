import { homedir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { childProcessEnvironment, loadConfig } from "./config";

afterEach(() => vi.unstubAllEnvs());

describe("loadConfig", () => {
  it("defaults the project root to the user's home directory", () => {
    vi.stubEnv("CODEXNEST_PROJECT_ROOT", "");
    expect(loadConfig().projectRoot).toBe(homedir());
  });

  it("loads a project root outside the service user's home and supports explicit overrides", () => {
    vi.stubEnv("CODEXNEST_PROJECT_ROOT", "/home/copy_trade");
    expect(loadConfig().projectRoot).toBe("/home/copy_trade");
    expect(loadConfig({ projectRoot: "/srv/work" }).projectRoot).toBe("/srv/work");
  });

  it("rejects relative project roots from the environment and explicit overrides", () => {
    vi.stubEnv("CODEXNEST_PROJECT_ROOT", "copy_trade");
    expect(() => loadConfig()).toThrow("CODEXNEST_PROJECT_ROOT must be an absolute directory path");
    vi.stubEnv("CODEXNEST_PROJECT_ROOT", "/home/copy_trade");
    expect(() => loadConfig({ projectRoot: "../work" })).toThrow("CODEXNEST_PROJECT_ROOT");
  });

  it("keeps direct stdio as the default transport", () => {
    vi.stubEnv("CODEXNEST_CODEX_TRANSPORT", "");
    expect(loadConfig().codexTransport).toBe("stdio");
  });

  it("places SQLite beside the legacy state path unless explicitly overridden", () => {
    vi.stubEnv("CODEXNEST_DATABASE_PATH", "");
    expect(loadConfig({ statePath: "/srv/codexnest/state.json" })).toMatchObject({
      statePath: "/srv/codexnest/state.json",
      databasePath: "/srv/codexnest/state.sqlite",
    });

    vi.stubEnv("CODEXNEST_DATABASE_PATH", "/data/codexnest/custom.sqlite");
    expect(loadConfig({ statePath: "/srv/codexnest/state.json" }).databasePath).toBe(
      "/data/codexnest/custom.sqlite",
    );
  });

  it("accepts the persistent daemon transport", () => {
    vi.stubEnv("CODEXNEST_CODEX_TRANSPORT", "daemon");
    expect(loadConfig().codexTransport).toBe("daemon");
  });

  it("rejects unknown transports", () => {
    vi.stubEnv("CODEXNEST_CODEX_TRANSPORT", "remote");
    expect(() => loadConfig()).toThrow("CODEXNEST_CODEX_TRANSPORT must be stdio or daemon");
  });

  it("loads and validates an optional session retention limit", () => {
    vi.stubEnv("CODEXNEST_SESSION_LIMIT", "400");
    expect(loadConfig().sessionLimit).toBe(400);

    vi.stubEnv("CODEXNEST_SESSION_LIMIT", "0");
    expect(() => loadConfig()).toThrow("CODEXNEST_SESSION_LIMIT must be a positive integer");
  });

  it("always allows the bundled Android client origin", () => {
    vi.stubEnv("CODEXNEST_ALLOWED_ORIGINS", "https://codex.home.arpa");
    expect(loadConfig().allowedOrigins).toEqual(
      new Set(["http://localhost", "https://codex.home.arpa"]),
    );
  });

  it("keeps app updates opt-in for unmanaged development checkouts", () => {
    vi.stubEnv("CODEXNEST_MANAGED_INSTALL", "");
    expect(loadConfig()).toMatchObject({
      managedInstall: false,
      updateStatusPath: expect.stringContaining("codexnest/update.json"),
      managementCli: expect.stringContaining(".local/bin/codexnest"),
    });
  });

  it("keeps speech-to-text optional and defaults OpenAI to the accurate model", () => {
    vi.stubEnv("CODEXNEST_STT_LOCAL_URL", "");
    vi.stubEnv("CODEXNEST_STT_OPENAI_API_KEY", "");
    vi.stubEnv("CODEXNEST_STT_OPENAI_MODEL", "");
    expect(loadConfig()).toMatchObject({
      sttLocalUrl: undefined,
      sttProvider: undefined,
      sttOpenAiApiKey: undefined,
      sttOpenAiModel: "gpt-4o-transcribe",
      sttLanguage: "ru",
      sttRefineLocal: true,
      sttRefinementModel: "gpt-5.6-luna",
      sttTimeoutMs: 600_000,
    });
  });

  it("loads and validates the global transcription mode", () => {
    vi.stubEnv("CODEXNEST_STT_PROVIDER", "openai");
    vi.stubEnv("CODEXNEST_STT_OPENAI_MODEL", "gpt-4o-mini-transcribe");
    vi.stubEnv("CODEXNEST_STT_LANGUAGE", "en-US");
    vi.stubEnv("CODEXNEST_STT_REFINE_LOCAL", "false");
    vi.stubEnv("CODEXNEST_STT_REFINEMENT_MODEL", "gpt-5.6-terra");
    expect(loadConfig()).toMatchObject({
      sttProvider: "openai",
      sttOpenAiModel: "gpt-4o-mini-transcribe",
      sttLanguage: "en-US",
      sttRefineLocal: false,
      sttRefinementModel: "gpt-5.6-terra",
    });

    vi.stubEnv("CODEXNEST_STT_PROVIDER", "device");
    expect(() => loadConfig()).toThrow("CODEXNEST_STT_PROVIDER");
  });

  it("rejects invalid OpenAI transcription models, languages, and booleans", () => {
    vi.stubEnv("CODEXNEST_STT_OPENAI_MODEL", "gpt-other");
    expect(() => loadConfig()).toThrow("CODEXNEST_STT_OPENAI_MODEL");

    vi.stubEnv("CODEXNEST_STT_OPENAI_MODEL", "gpt-4o-transcribe");
    vi.stubEnv("CODEXNEST_STT_LANGUAGE", "not a language");
    expect(() => loadConfig()).toThrow("CODEXNEST_STT_LANGUAGE");

    vi.stubEnv("CODEXNEST_STT_LANGUAGE", "ru");
    vi.stubEnv("CODEXNEST_STT_REFINE_LOCAL", "sometimes");
    expect(() => loadConfig()).toThrow("CODEXNEST_STT_REFINE_LOCAL");
  });

  it("validates local transcription URLs and timeouts", () => {
    vi.stubEnv("CODEXNEST_STT_LOCAL_URL", "ftp://localhost/model");
    expect(() => loadConfig()).toThrow("CODEXNEST_STT_LOCAL_URL");
    vi.stubEnv("CODEXNEST_STT_LOCAL_URL", "http://127.0.0.1:8178/inference");
    vi.stubEnv("CODEXNEST_STT_TIMEOUT_MS", "999");
    expect(() => loadConfig()).toThrow("CODEXNEST_STT_TIMEOUT_MS");
  });

  it("does not pass the transcription API key to child processes", () => {
    vi.stubEnv("CODEXNEST_STT_OPENAI_API_KEY", "secret");
    expect(childProcessEnvironment({ EXTRA_VALUE: "kept" })).toMatchObject({ EXTRA_VALUE: "kept" });
    expect(childProcessEnvironment()).not.toHaveProperty("CODEXNEST_STT_OPENAI_API_KEY");
  });
});
