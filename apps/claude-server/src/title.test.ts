import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeLaunchAccount } from "./accounts";
import { createClaudeProxyEnvironment } from "./proxy";
import { claudeTitleGenerator } from "./title";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0)) await task();
  vi.unstubAllEnvs();
});

/** A stand-in for the Claude CLI that records how it was called and prints a canned answer. */
async function fakeClaude(answer: string, exitCode = 0) {
  const directory = await mkdtemp(join(tmpdir(), "claudenest-title-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const record = join(directory, "call.json");
  const bin = join(directory, "claude");
  await writeFile(
    bin,
    `#!${process.execPath}
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks).toString();
  require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), input, configDir: process.env.CLAUDE_CONFIG_DIR }));
  process.stdout.write(${JSON.stringify(answer)});
  process.exitCode = ${exitCode};
});
`,
  );
  await chmod(bin, 0o755);
  return {
    bin,
    call: async () =>
      JSON.parse(await readFile(record, "utf8")) as {
        args: string[];
        input: string;
        configDir?: string;
      },
  };
}

const PNG = "data:image/png;base64,aW1hZ2U=";

describe("claudeTitleGenerator", () => {
  it("resolves the current account and its proxy for every title", async () => {
    const claude = await fakeClaude('{"structured_output":{"title":"Fix titles"}}');
    let account: ClaudeLaunchAccount = {
      accountId: "first",
      configDir: "/accounts/first",
      proxy: null,
    };
    const accounts = { launchAccount: vi.fn(async () => account) };
    const close = vi.fn(async () => {});
    const proxyEnvironment = vi.fn<typeof createClaudeProxyEnvironment>(async (...args) => {
      const connection = await createClaudeProxyEnvironment(...args);
      return { env: connection.env, close };
    });
    const generate = claudeTitleGenerator({
      claudeBin: claude.bin,
      configDir: "/original/exhausted-account",
      accounts,
      proxyEnvironment,
    });
    await expect(generate("Fix titles")).resolves.toBe("Fix titles");
    expect((await claude.call()).configDir).toBe("/accounts/first");
    expect(proxyEnvironment).toHaveBeenLastCalledWith(null, "/accounts/first");
    account = {
      accountId: "second",
      configDir: "/accounts/second",
      proxy: {
        protocol: "http",
        host: "proxy.example",
        port: 8080,
        url: "http://proxy.example:8080",
      },
    };
    await expect(generate("Fix titles")).resolves.toBe("Fix titles");
    expect((await claude.call()).configDir).toBe("/accounts/second");
    expect(proxyEnvironment).toHaveBeenLastCalledWith(account.proxy, account.configDir);
    expect(accounts.launchAccount).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("keeps native default config discovery when the original account is selected", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/inherited/account");
    const claude = await fakeClaude('{"structured_output":{"title":"Fix titles"}}');
    const accounts = {
      launchAccount: async () => ({
        accountId: "original",
        configDir: "/home/example/.claude",
        defaultConfig: true,
        proxy: null,
      }),
    };
    await claudeTitleGenerator({ claudeBin: claude.bin, accounts })("Fix titles");
    expect((await claude.call()).configDir).toBeUndefined();
  });

  it("closes the account proxy when the CLI fails", async () => {
    const claude = await fakeClaude("", 1);
    const close = vi.fn(async () => {});
    const accounts = {
      launchAccount: async () => ({ accountId: "selected", configDir: "/selected", proxy: null }),
    };
    await expect(
      claudeTitleGenerator({
        claudeBin: claude.bin,
        accounts,
        proxyEnvironment: async () => ({ env: {}, close }),
      })("Fix titles"),
    ).rejects.toThrow("Claude title generation failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("sends a text-only request through the plain JSON format", async () => {
    const claude = await fakeClaude('{"structured_output":{"title":"  Fix   login  "}}');
    const title = await claudeTitleGenerator({ claudeBin: claude.bin })("Fix the login", "sonnet");
    expect(title).toBe("Fix login");
    const { args, input } = await claude.call();
    expect(args).toEqual(expect.arrayContaining(["--output-format", "json", "--model", "sonnet"]));
    expect(args).not.toContain("--input-format");
    expect(input).toBe("<request>\nFix the login\n</request>");
  });

  it("sends the first images with the request as streaming input", async () => {
    const claude = await fakeClaude(
      [
        '{"type":"system","subtype":"init"}',
        "not json",
        '{"type":"result","is_error":false,"structured_output":{"title":"Скриншот ошибки"}}',
      ].join("\n"),
    );
    const images = [PNG, "data:image/jpeg;base64,YQ==\n", PNG, PNG];
    const title = await claudeTitleGenerator({ claudeBin: claude.bin })("Why?", undefined, images);
    expect(title).toBe("Скриншот ошибки");
    const { args, input } = await claude.call();
    expect(args).toEqual(
      expect.arrayContaining(["--input-format", "stream-json", "--output-format", "stream-json"]),
    );
    expect(args).toContain("--verbose");
    const message = JSON.parse(input) as {
      type: string;
      message: { role: string; content: Array<Record<string, unknown>> };
    };
    expect(message).toMatchObject({ type: "user", message: { role: "user" } });
    expect(message.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "YQ==" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      { type: "text", text: "<request>\nWhy?\n</request>" },
    ]);
  });

  it("falls back to the plain format when no image is usable", async () => {
    const claude = await fakeClaude('{"structured_output":{"title":"Notes"}}');
    const title = await claudeTitleGenerator({ claudeBin: claude.bin })("Notes", undefined, [
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "https://example.invalid/a.png",
    ]);
    expect(title).toBe("Notes");
    expect((await claude.call()).args).not.toContain("--input-format");
  });

  it("rejects a streaming answer without a result", async () => {
    const claude = await fakeClaude('{"type":"system","subtype":"init"}\n');
    await expect(
      claudeTitleGenerator({ claudeBin: claude.bin })("Why?", undefined, [PNG]),
    ).rejects.toThrow("Invalid Claude title response");
  });
});
