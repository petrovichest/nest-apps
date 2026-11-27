import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";
import { afterEach, describe, expect, it } from "vitest";
import { browserResult, OpenNestPlugin } from "./plugin";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function fixture() {
  const config = await mkdtemp(join(tmpdir(), "opennest-plugin-"));
  cleanup.push(() => rm(config, { recursive: true, force: true }));
  const token = "fixture-private-api-token";
  await writeFile(join(config, "token"), token, { mode: 0o600 });
  const requests: Array<Record<string, any>> = [],
    operations = new Map<string, string>();
  const server = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const call = JSON.parse(raw);
    requests.push(call);
    const id = `${call.sessionID}:${call.callID}:${call.tool}`;
    if (!operations.has(id)) operations.set(id, `operation-${operations.size + 1}`);
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ operation: operations.get(id) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const before = { ...process.env };
  cleanup.push(async () => {
    process.env = before;
  });
  process.env.OPENNEST_CONFIG_DIR = config;
  process.env.OPENNEST_PORT = String((server.address() as { port: number }).port);
  const plugin = await OpenNestPlugin({} as Parameters<typeof OpenNestPlugin>[0]);
  const context = (callID?: string) =>
    ({
      sessionID: "ses_fixture",
      messageID: "msg_same_assistant",
      ...(callID ? { callID } : {}),
      abort: new AbortController().signal,
    }) as ToolContext;
  return { plugin, context, requests, operations, token };
}

describe("OpenNest native tool identity", () => {
  it("preserves distinct native calls with identical arguments in one assistant message, including parallel execution", async () => {
    const f = await fixture();
    const get = f.plugin.tool!.get_goal!;
    const results = await Promise.all([
      get.execute({}, f.context("call_first")),
      get.execute({}, f.context("call_second")),
    ]);
    expect(new Set(results).size).toBe(2);
    expect(f.requests.map((call) => call.callID).sort()).toEqual(["call_first", "call_second"]);
    expect(f.requests.every((call) => call.messageID === "msg_same_assistant")).toBe(true);
    expect(f.operations.size).toBe(2);
    expect(results.join(" ")).not.toContain(f.token);
  });
  it("keeps the same native identity on a repeated execution so the backend can return one recorded operation", async () => {
    const f = await fixture();
    const execute = f.plugin.tool!.get_goal!.execute;
    const first = await execute({}, f.context("call_replayed"));
    const second = await execute({}, f.context("call_replayed"));
    expect(first).toBe(second);
    expect(f.operations.size).toBe(1);
    expect(f.requests).toHaveLength(2);
  });
  it("routes session messages with the native sender identity", async () => {
    const f = await fixture();
    const args = { session: "Session: CodexNest\nID: target", message: "How did the check go?" };
    await f.plugin.tool!.codexnest_send_message!.execute(args, f.context("call_send"));
    expect(f.requests).toEqual([
      {
        tool: "send_message",
        sessionID: "ses_fixture",
        messageID: "msg_same_assistant",
        callID: "call_send",
        args,
      },
    ]);
  });
  it("rejects missing native identity and never accepts a model argument as its replacement", async () => {
    const f = await fixture();
    const execute = f.plugin.tool!.get_goal!.execute;
    await expect(execute({ callID: "forged_by_model" }, f.context())).rejects.toThrow(
      "identity is unavailable",
    );
    expect(f.requests).toHaveLength(0);
    await execute({ callID: "forged_by_model" }, f.context("call_actual"));
    expect(f.requests[0]!.callID).toBe("call_actual");
    expect(f.requests[0]!.args.callID).toBe("forged_by_model");
  });
});

describe("native browser tools", () => {
  it("preserves screenshot pixels as a native attachment without filling text with base64", () => {
    const result = browserResult({
      content: [
        { type: "text", text: "Page" },
        { type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
      ],
    });
    expect(result).toMatchObject({
      attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,cGl4ZWxz" }],
    });
    expect(typeof result === "object" && result.output).toContain("Page");
    expect(typeof result === "object" && result.output).not.toContain("cGl4ZWxz");
  });
  it("uses canonical browser schemas and routes the native identity to the bound session", async () => {
    const f = await fixture();
    const browser = f.plugin.tool!.browser_computer!;
    expect(browser.args.action!.safeParse("screenshot").success).toBe(true);
    expect(browser.args.action!.safeParse("invented").success).toBe(false);
    expect(browser.args.count!.safeParse(4).success).toBe(false);
    await browser.execute({ action: "screenshot" }, f.context("call_browser"));
    expect(f.requests[0]).toMatchObject({
      tool: "browser:computer",
      sessionID: "ses_fixture",
      callID: "call_browser",
      args: { action: "screenshot" },
    });
  });
});
