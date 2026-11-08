#!/usr/bin/env node
// Deterministic ACP agent for integration checks. Never contacts a model provider.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
if (process.argv.includes("--version")) {
  process.stdout.write("1.5.3-fixture\n");
  process.exit(0);
}
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.HTTPS_PROXY || "")) process.exit(2);
if (process.argv.includes("/usage")) {
  process.stdout.write(
    JSON.stringify({
      conversation_id: "",
      status: "SUCCESS",
      response: "",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                {
                  id: "gemini-weekly",
                  name: "Weekly Limit Remaining",
                  window: "weekly",
                  remaining_fraction: 0.82,
                  reset_time: "2026-11-14T23:24:41Z",
                },
                {
                  id: "gemini-5h",
                  name: "Five Hour Limit Remaining",
                  window: "5h",
                  remaining_fraction: 0.8,
                  reset_time: "2026-11-08T14:24:41Z",
                },
              ],
            },
          ],
        },
      },
    }) + "\n",
  );
  process.exit(0);
}
if (process.argv.includes("--login")) {
  process.stdout.write(
    "Open this link in a browser to log in with Google:\nhttps://accounts.google.com/o/oauth2/auth?state=fixture\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n",
  );
  process.stdin.once("data", (data) =>
    process.exit(data.toString().trim() === "fixture-code" ? 0 : 1),
  );
} else {
  const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const sessions = new Set();
  const pending = new Map();
  const options = [
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "gemini-fixture",
      type: "select",
      options: [{ value: "gemini-fixture", name: "Gemini Fixture" }],
    },
  ];
  const reply = (request) => {
    send({
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Gemini fixture completed." },
        },
      },
    });
    send({ id: request.id, result: { stopReason: "end_turn" } });
  };
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    const { id, method, params } = request;
    if (method === "initialize")
      send({
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fixture", version: "1.5.3" },
          agentCapabilities: { loadSession: true },
          authMethods: [],
        },
      });
    else if (method === "session/new" || method === "session/load") {
      const sessionId = params.sessionId || randomUUID();
      sessions.add(sessionId);
      send({ id, result: { sessionId, configOptions: options } });
    } else if (method === "session/set_config_option")
      send({ id, result: { configOptions: options } });
    else if (method === "session/prompt") {
      if (!sessions.has(params.sessionId)) {
        send({ id, error: { code: -32602, message: "Unknown session" } });
        return;
      }
      if (params.prompt[0].text.includes("approval")) {
        const decisionId = randomUUID();
        pending.set(decisionId, request);
        send({
          id: decisionId,
          method: "session/request_permission",
          params: {
            sessionId: params.sessionId,
            toolCall: { toolCallId: randomUUID(), title: "Fixture file write", kind: "edit" },
            options: [
              { optionId: "allow", kind: "allow_once", name: "Allow" },
              { optionId: "deny", kind: "reject_once", name: "Deny" },
            ],
          },
        });
      } else setTimeout(() => reply(request), 150);
    } else if (method === "session/cancel") {
      for (const [key, prompt] of pending)
        if (prompt.params.sessionId === params.sessionId) {
          pending.delete(key);
          send({ id: prompt.id, result: { stopReason: "cancelled" } });
        }
    } else if (pending.has(id)) {
      const prompt = pending.get(id);
      pending.delete(id);
      reply(prompt);
    } else if (method) send({ id, error: { code: -32601, message: "Unsupported method" } });
  });
}
