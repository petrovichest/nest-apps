import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KanbanProvider, ThreadSummary } from "@codexnest/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerSessionMessaging } from "./session-messaging.js";

const ids = {
  codex: "10000000-0000-4000-8000-000000000000",
  claude: "10000000-0000-4000-8000-000000000001",
  gemini: "10000000-0000-4000-8000-000000000002",
  open: "ses_fixture",
} as const;
const otherCodexId = "10000000-0000-4000-8000-000000000003";
const localThreads: Pick<ThreadSummary, "archived" | "currentTurnId" | "relation"> = {
  archived: false,
  currentTurnId: "turn-1",
  relation: { kind: "session", sessionId: "" },
};
const apps: FastifyInstance[] = [];
let directory: string | undefined;

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  vi.unstubAllEnvs();
});

async function start(provider: KanbanProvider) {
  const app = Fastify();
  apps.push(app);
  const messages = new Map<string, { id: string; text: string }>();
  const messaging = registerSessionMessaging(app, {
    provider,
    port: 0,
    credential: `fixture-${provider}`,
    thread: (id) =>
      id === ids[provider] || (provider === "codex" && id === otherCodexId)
        ? localThreads
        : undefined,
    ...(provider === "gemini"
      ? { resolveThreadId: (id: string) => (id === "native-gemini-id" ? ids.gemini : undefined) }
      : {}),
    enqueue: async (id, text, messageId) => messages.set(messageId, { id, text }),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  await vi.waitFor(async () =>
    expect((await lstat(join(directory!, `${provider}.sock`))).isSocket()).toBe(true),
  );
  return { app, messaging, messages };
}

it("uses the copied reference to send through all four apps and reply to the verified sender", async () => {
  directory = await mkdtemp(join(tmpdir(), "nest-session-messaging-test-"));
  vi.stubEnv("NEST_SESSION_MESSAGING_DIR", directory);
  const codex = await start("codex");
  const claude = await start("claude");
  const gemini = await start("gemini");
  const open = await start("open");
  const message = {
    session:
      "Сессия: GeminiNest\nID: native-gemini-id\nРабочая папка: /example\nФайл истории: /unused",
    message: "Какой результат проверки?",
    requestReply: true,
  };
  const receipt = await codex.messaging.send(ids.codex, message, "first");
  expect(receipt).toMatchObject({ status: "queued" });
  expect(await codex.messaging.send(ids.codex, message, "first")).toEqual(receipt);
  expect(gemini.messages.size).toBe(1);
  const incoming = gemini.messages.get(receipt.messageId);
  expect(incoming).toEqual({
    id: ids.gemini,
    text: expect.stringContaining(
      `Сессия: CodexNest\nID: ${ids.codex}\n\nКакой результат проверки?`,
    ),
  });

  const { url, headers } = gemini.messaging.mcp(ids.gemini);
  const result = await gemini.app.inject({
    method: "POST",
    url: new URL(url).pathname,
    headers,
    payload: {
      jsonrpc: "2.0",
      method: "tools/call",
      id: 1,
      params: {
        name: "send_message",
        arguments: {
          session: incoming!.text.split("\n").slice(1, 3).join("\n"),
          message: "Проверка пройдена.",
        },
      },
    },
  });
  expect(JSON.parse(result.json().result.content[0].text)).toMatchObject({ status: "queued" });
  expect([...codex.messages.values()]).toEqual([
    {
      id: ids.codex,
      text: expect.stringContaining(`Сессия: GeminiNest\nID: ${ids.gemini}\n\nПроверка пройдена.`),
    },
  ]);

  await claude.messaging.send(
    ids.claude,
    {
      session: `Session: OpenNest\nID: ${ids.open}`,
      message: "Проверь статус",
    },
    "second",
  );
  expect([...open.messages.values()]).toEqual([
    { id: ids.open, text: expect.stringContaining("Проверь статус") },
  ]);
  await open.messaging.send(
    ids.open,
    {
      session: `Session: ClaudeNest\nID: ${ids.claude}`,
      message: "Готово",
    },
    "third",
  );
  expect([...claude.messages.values()]).toEqual([
    { id: ids.claude, text: expect.stringContaining("Готово") },
  ]);
  await codex.messaging.send(ids.codex, { session: otherCodexId, message: "Привет" }, "local");
  expect([...codex.messages.values()].at(-1)).toMatchObject({ id: otherCodexId });
});

it("rejects forged sender credentials, unknown references and unavailable peers", async () => {
  directory = await mkdtemp(join(tmpdir(), "nest-session-messaging-test-"));
  vi.stubEnv("NEST_SESSION_MESSAGING_DIR", directory);
  const { app, messaging, messages } = await start("codex");
  const { url, headers } = messaging.mcp(ids.codex);
  const payload = { jsonrpc: "2.0", method: "tools/list", id: 1 };
  const request = { method: "POST" as const, url: new URL(url).pathname, headers, payload };
  expect((await app.inject({ ...request, headers: {} })).statusCode).toBe(403);
  expect(
    (await app.inject({ ...request, url: new URL(messaging.mcp(otherCodexId).url).pathname }))
      .statusCode,
  ).toBe(403);
  expect((await app.inject(request)).json().result.tools[0].name).toBe("send_message");
  await expect(
    messaging.send(ids.codex, { session: ids.codex, message: "x" }, "self"),
  ).rejects.toThrow("Choose another session");
  await expect(
    messaging.send(
      ids.codex,
      { session: `Session: unknown\nID: ${otherCodexId}`, message: "x" },
      "invalid",
    ),
  ).rejects.toThrow("Nest application name");
  await expect(
    messaging.send(
      ids.codex,
      { session: `Session: ClaudeNest\nID: ${ids.claude}`, message: "x" },
      "offline",
    ),
  ).rejects.toThrow("ClaudeNest is unavailable");
  expect(messages.size).toBe(0);
});
