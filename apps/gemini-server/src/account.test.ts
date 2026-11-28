import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Account } from "./account";
import { paths } from "./config";
import { readGeminiModels } from "./models";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("completes native Google sign-in from a UI code and never exposes proxy credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "gemininest-login-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "agy");
  await writeFile(
    bin,
    `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('1.5.3');process.exit(0)}\nif(!process.env.HTTPS_PROXY?.startsWith('http://127.0.0.1:'))process.exit(1);\nconsole.log('Open this link in a browser to log in with Google:\\nhttps://accounts.google.com/o/oauth2/auth?state=test\\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:');\nprocess.stdin.once('data', data=>process.exit(data.toString().trim()==='valid-code'?0:1));\n`,
    { mode: 0o700 },
  );
  const config = {
    ...paths({
      GEMININEST_CONFIG_DIR: root,
      GEMININEST_STATE_DIR: join(root, "state"),
      GEMININEST_AGY_BIN: bin,
    }),
    token: "t".repeat(48),
  };
  const account = new Account(config);
  cleanups.push(() => account.close());
  await account.initialize();
  await account.setProxy("http://user:password@proxy.example:3128");
  expect(account.status().proxy).toEqual({
    configured: true,
    address: "http://proxy.example:3128/",
    hasPassword: true,
  });
  expect((await stat(join(root, "connection.json"))).mode & 0o777).toBe(0o600);
  await account.startLogin();
  await vi.waitFor(() => expect(account.status().login?.state).toBe("awaiting_code"));
  const id = account.status().login!.id;
  expect(() => account.submitCode(id, "valid-code\nsecond")).toThrow();
  account.submitCode(id, "valid-code");
  await vi.waitFor(() => expect(account.status().login?.state).toBe("completed"));
  expect(account.status().authenticated).toBe(true);
  expect(JSON.stringify(account.status())).not.toContain("password");
  expect(await readFile(join(root, "connection.json"), "utf8")).not.toContain("valid-code");
  await account.startLogin();
  await account.cancelLogin();
  expect(account.status().login).toMatchObject({ state: "cancelled", url: null });
});

const isolationAvailable =
  spawnSync("/usr/bin/bwrap", [
    "--unshare-net",
    "--unshare-pid",
    "--bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--",
    "/bin/true",
  ]).status === 0;

it.skipIf(!isolationAvailable)(
  "imports and refreshes a private CLI session through the account proxy and blocks a direct route",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gemininest-token-login-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const requests: string[] = [];
    const proxy = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.end("through-fixture-proxy");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Proxy address unavailable");

    // Try direct HTTP to the host's port, then forward an HTTP request using the CLI proxy.
    // The fixture rotates its cache just as the native OAuth reader does.
    const bin = join(root, "agy.mjs");
    await writeFile(
      bin,
      `#!${process.execPath}
import { readFile, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { join } from "node:path";
if (process.argv.includes("--version")) {
  console.log("fixture");
  process.exit(0);
}
const read = (url, options) => new Promise((resolve, reject) => {
  const req = get(url, options, async (res) => {
    let body = "";
    for await (const chunk of res) body += chunk;
    resolve(body);
  });
  req.on("error", reject);
  req.setTimeout(1000, () => req.destroy(new Error("timeout")));
});
const direct = await read("http://127.0.0.1:${address.port}/direct").then(() => true, () => false);
if (direct) process.exit(2);
const path = join(process.argv[process.argv.indexOf("--gemini_dir") + 1], "gemininest", "antigravity-oauth-token");
const session = JSON.parse(await readFile(path, "utf8"));
if (session.token.refresh_token === "rejected-fixture") process.exit(1);
const body = await read(process.env.HTTPS_PROXY, { path: "http://oauth.fixture.invalid/" });
if (body !== "through-fixture-proxy") process.exit(3);
session.token.access_token = "fixture-access";
session.token.refresh_token = "rotated-fixture";
await writeFile(path, JSON.stringify(session));
console.log("gemini-fixture  Gemini Fixture");
`,
      { mode: 0o700 },
    );

    const config = {
      ...paths({
        GEMININEST_CONFIG_DIR: root,
        GEMININEST_STATE_DIR: join(root, "state"),
        GEMININEST_AGY_BIN: bin,
      }),
      token: "t".repeat(48),
    };
    const account = new Account(config);
    cleanups.push(() => account.close());
    await account.initialize();
    await expect(account.importRefreshToken("fixture-refresh")).rejects.toThrow("прокси");
    await account.setProxy(`http://127.0.0.1:${address.port}`);

    const legacy = join(config.nativeDir, "gemininest");
    await mkdir(legacy, { recursive: true });
    const nativeToken = join(legacy, "antigravity-oauth-token");
    await writeFile(nativeToken, "existing Google sign-in", { mode: 0o600 });
    await expect(account.importRefreshToken("fixture-refresh")).resolves.toMatchObject({
      authenticated: true,
    });
    expect(await readFile(nativeToken, "utf8")).toBe("existing Google sign-in");
    const tokenPath = join(root, "imported-antigravity-oauth-token");
    const saved = await readFile(tokenPath, "utf8");
    expect(saved).toContain("rotated-fixture");
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(root, "connection.json"), "utf8")).not.toContain("rotated-fixture");
    await expect(account.importRefreshToken("rejected-fixture")).rejects.toThrow(
      "сохранённый прокси",
    );
    expect(await readFile(tokenPath, "utf8")).toBe(saved);
    expect(account.status().authenticated).toBe(true);

    const restored = new Account(config);
    cleanups.push(() => restored.close());
    await restored.initialize();
    const connection = await restored.connection();
    try {
      await expect(readGeminiModels(connection.native, connection.env)).resolves.toMatchObject([
        { id: "gemini-fixture" },
      ]);
    } finally {
      await connection.close();
    }
    expect(requests).toEqual(["http://oauth.fixture.invalid/", "http://oauth.fixture.invalid/"]);
  },
);
