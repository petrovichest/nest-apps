import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Account } from "./account";
import { paths } from "./config";
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
