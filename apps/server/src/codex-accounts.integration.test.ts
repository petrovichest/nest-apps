import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { CodexAccounts } from "./codex-accounts";
import { CodexBridge } from "./codex/bridge";

// An opt-in native protocol check with synthetic credentials and a loopback backend.
// Never reads the user's CODEX_HOME or starts a conversation.
it.skipIf(!process.env.CODEXNEST_ACCOUNT_CODEX_BIN)(
  "loads managed native credentials and supplies external tokens to the shared bridge",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-accounts-native-"));
    const backend = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    const address = backend.address() as { port: number };
    const id = randomUUID();
    const home = join(root, "codex-accounts", id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const claims = {
      sub: "test-user",
      email: "synthetic@example.test",
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "test-workspace",
        chatgpt_user_id: "test-user",
        chatgpt_plan_type: "plus",
      },
    };
    const jwt = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: jwt,
          access_token: jwt,
          refresh_token: "synthetic-refresh",
          account_id: "test-workspace",
        },
        last_refresh: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(home, "config.toml"),
      `chatgpt_base_url = "http://127.0.0.1:${address.port}"
[analytics]
enabled = false
`,
    );
    await writeFile(
      join(root, "codex-accounts.json"),
      JSON.stringify({
        version: 1,
        importedNative: true,
        currentAccountId: id,
        accounts: [
          {
            id,
            identity: "test-workspace:test-user",
            email: null,
            plan: null,
            authenticated: true,
          },
        ],
      }),
    );
    const mainHome = join(root, "main");
    await mkdir(mainHome);
    await writeFile(
      join(mainHome, "config.toml"),
      await readFile(join(home, "config.toml"), "utf8"),
    );
    const env = { ...process.env, CODEX_HOME: mainHome };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    const bridge = new CodexBridge({
      codexBin: process.env.CODEXNEST_ACCOUNT_CODEX_BIN!,
      checkVersion: async () => "isolated-account-test",
      spawnProcess: () =>
        spawn(
          process.env.CODEXNEST_ACCOUNT_CODEX_BIN!,
          [
            "--enable",
            "respect_system_proxy",
            "-c",
            'cli_auth_credentials_store="file"',
            "app-server",
            "--listen",
            "stdio://",
          ],
          { env, stdio: ["pipe", "pipe", "pipe"] },
        ),
    });
    const requests = vi.spyOn(bridge, "request");
    const accounts = new CodexAccounts(bridge, {
      stateDir: root,
      codexHome: join(root, "unused-native-home"),
      codexBin: process.env.CODEXNEST_ACCOUNT_CODEX_BIN!,
      proxyEnvFile: join(root, "no-proxy.env"),
      activeTurnCount: () => 0,
    });
    try {
      await bridge.start();
      expect(bridge.ready).toBe(true);
      await accounts.initialize();
      await accounts.restore();
      expect(accounts.status().accounts[0]).toMatchObject({
        email: "synthetic@example.test",
        plan: "plus",
        authenticated: true,
      });
      expect(requests).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: jwt,
        chatgptAccountId: "test-workspace",
        chatgptPlanType: "plus",
      });
      expect(
        await bridge.request("getAuthStatus", { includeToken: true, refreshToken: false }),
      ).toMatchObject({ authMethod: "chatgptAuthTokens", authToken: jwt });
      expect(JSON.stringify(accounts.status())).not.toContain(jwt);
    } finally {
      bridge.stop();
      await accounts.close();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
