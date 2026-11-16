import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

/** Controlled native HTTP boundary; tests still exercise the real Nest facade and client. */
export async function startNativeFixture() {
  const sessions = new Map(),
    messages = new Map(),
    statuses = new Map();
  const questions = new Map(),
    permissions = new Map(),
    streams = new Set();
  const prompts = [];
  let savedKey = false;
  const publish = (type, properties, directory) => {
    const body = JSON.stringify({ directory, payload: { type, properties } });
    for (const stream of streams) stream.write(`data: ${body}\n\n`);
  };
  function finish(id, text = "Fixture answer completed.") {
    const all = messages.get(id) ?? [];
    const parent = all.findLast((item) => item.info.role === "user");
    const message = {
      info: {
        id: `msg_${randomUUID()}`,
        sessionID: id,
        parentID: parent?.info.id,
        role: "assistant",
        finish: "stop",
        time: { created: Date.now(), completed: Date.now() },
      },
      parts: [],
    };
    const part = {
      id: `prt_${randomUUID()}`,
      messageID: message.info.id,
      sessionID: id,
      type: "text",
      text,
    };
    all.push(message);
    messages.set(id, all);
    message.parts.push(part);
    publish("message.updated", { info: message.info }, sessions.get(id).directory);
    publish("message.part.updated", { part }, sessions.get(id).directory);
    statuses.delete(id);
    publish(
      "session.status",
      { sessionID: id, status: { type: "idle" } },
      sessions.get(id).directory,
    );
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    const path = url.pathname;
    const cwd = url.searchParams.get("directory");
    const json = (value, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const empty = () => {
      res.writeHead(204);
      res.end();
    };
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    if (path === "/global/health") return json({ healthy: true, version: "1.19.5" });
    if (path === "/global/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      streams.add(res);
      res.write('data: {"payload":{"type":"server.connected","properties":{}}}\n\n');
      res.once("close", () => streams.delete(res));
      return;
    }
    if (path === "/provider")
      return json({
        all: [
          {
            id: "openrouter",
            models: {
              "anthropic/claude-sonnet-4.6": {
                id: "anthropic/claude-sonnet-4.6",
                name: "Claude Sonnet 4.6",
                variants: { low: {}, high: {} },
                capabilities: { attachment: true, input: { image: true } },
              },
              "google/gemini-2.5-pro": {
                id: "google/gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                variants: { low: {}, high: {} },
                capabilities: { attachment: true, input: { image: true } },
              },
            },
          },
        ],
        connected: ["openrouter"],
        default: { openrouter: "anthropic/claude-sonnet-4.6" },
      });
    if (path === "/auth/openrouter") {
      savedKey = req.method === "PUT";
      return json(true);
    }
    if (path === "/instance/dispose") return json(true);
    if (path === "/config")
      return json({ model: "openrouter/anthropic/claude-sonnet-4.6", permission: { "*": "ask" } });
    if (path === "/experimental/session") return json([...sessions.values()]);
    if (path === "/session/status")
      return json(
        Object.fromEntries(
          [...statuses].filter(([id]) => !cwd || sessions.get(id)?.directory === cwd),
        ),
      );
    if (path === "/session" && req.method === "GET")
      return json([...sessions.values()].filter((s) => !cwd || s.directory === cwd));
    if (path === "/session" && req.method === "POST") {
      const id = `ses_${randomUUID()}`;
      const session = {
        id,
        title: input.title || "Browser smoke",
        directory: cwd,
        parentID: input.parentID,
        time: { created: Date.now(), updated: Date.now() },
      };
      sessions.set(id, session);
      messages.set(id, []);
      publish("session.created", { info: session }, cwd);
      return json(session);
    }
    if (path === "/question")
      return json(
        [...questions.values()].filter((q) => !cwd || sessions.get(q.sessionID)?.directory === cwd),
      );
    if (path === "/permission")
      return json(
        [...permissions.values()].filter(
          (q) => !cwd || sessions.get(q.sessionID)?.directory === cwd,
        ),
      );
    if (path === "/skill") return json([]);
    if (path === "/mcp") return json({});
    const request = path.match(/^\/(question|permission)\/([^/]+)\/reply$/);
    if (request) {
      const map = request[1] === "question" ? questions : permissions;
      const pending = map.get(request[2]);
      if (!pending) return json({}, 404);
      map.delete(request[2]);
      publish(
        `${request[1]}.replied`,
        { sessionID: pending.sessionID, requestID: request[2] },
        sessions.get(pending.sessionID).directory,
      );
      finish(
        pending.sessionID,
        request[1] === "question" ? "Question answered." : "Permission handled.",
      );
      return json(true);
    }
    const match = path.match(/^\/session\/([^/]+)(?:\/(.*))?$/);
    if (!match) return json({ name: "NotFound", data: {} }, 404);
    const id = match[1],
      suffix = match[2];
    if (!sessions.has(id)) return json({}, 404);
    if (!suffix) {
      if (req.method === "PATCH") Object.assign(sessions.get(id), input);
      return json(sessions.get(id));
    }
    if (suffix === "message") return json(messages.get(id));
    if (suffix === "abort") {
      statuses.delete(id);
      publish(
        "session.status",
        { sessionID: id, status: { type: "idle" } },
        sessions.get(id).directory,
      );
      return json(true);
    }
    if (suffix === "fork") {
      const child = `ses_${randomUUID()}`;
      const session = { ...sessions.get(id), id: child, parentID: id };
      sessions.set(child, session);
      messages.set(child, structuredClone(messages.get(id)));
      return json(session);
    }
    if (suffix !== "prompt_async") return json({}, 404);
    prompts.push({ id, input });
    const message = {
      info: { id: input.messageID, sessionID: id, role: "user", time: { created: Date.now() } },
      parts: (input.parts ?? []).map((part) => ({
        ...part,
        id: `prt_${randomUUID()}`,
        messageID: input.messageID,
        sessionID: id,
      })),
    };
    messages.get(id).push(message);
    statuses.set(id, { type: "busy" });
    publish("message.updated", { info: message.info }, sessions.get(id).directory);
    for (const part of message.parts)
      publish("message.part.updated", { part }, sessions.get(id).directory);
    publish(
      "session.status",
      { sessionID: id, status: { type: "busy" } },
      sessions.get(id).directory,
    );
    empty();
    const prompt = (input.parts ?? []).map((p) => p.text || "").join("\n");
    if (prompt.includes("hold")) return;
    setTimeout(() => {
      if (prompt.includes("question")) {
        const question = {
          id: `que_${randomUUID()}`,
          sessionID: id,
          questions: [
            {
              header: "Contract",
              question: "Continue browser probe?",
              options: [{ label: "Continue", description: "Finish browser probe" }],
              custom: true,
            },
          ],
        };
        questions.set(question.id, question);
        publish("question.asked", question, sessions.get(id).directory);
      } else finish(id, `Fixture answer: ${prompt}`);
    }, 60);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const timer = setInterval(() => publish("server.heartbeat", {}), 1_000);
  timer.unref();
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    prompts,
    sessions,
    messages,
    questions,
    get savedKey() {
      return savedKey;
    },
    async close() {
      clearInterval(timer);
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
