import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tool, type Plugin, type ToolResult } from "@opencode-ai/plugin";
import { enforceToolPolicy, readToolPolicy } from "./tool-policy";
import { browserPluginTools } from "./browser-plugin-tools";
import { nativeEventRelay } from "./event-relay";

/** Loaded only in the separately owned OpenNest native service. */
export const OpenNestPlugin: Plugin = async () => {
  const configDir = process.env.OPENNEST_CONFIG_DIR || join(homedir(), ".config/opennest");
  const stateDir = process.env.OPENNEST_STATE_DIR || join(homedir(), ".local/state/opennest");
  const port = Number(process.env.OPENNEST_PORT || 4313);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid OpenNest tool endpoint");
  const key = (await readFile(join(configDir, "token"), "utf8")).trim();
  const relay = process.env.OPENNEST_EVENT_SOCKET
    ? await nativeEventRelay({ socketPath: process.env.OPENNEST_EVENT_SOCKET, token: key })
    : undefined;
  const access = tool.schema.object({
    mode: tool.schema.enum(["readOnly", "isolatedWrite", "sharedWrite"]).optional(),
    writePaths: tool.schema.array(tool.schema.string()).optional(),
    network: tool.schema.boolean().optional(),
  });
  const call =
    (name: string) =>
    async (
      args: Record<string, unknown>,
      context: { sessionID: string; messageID: string; callID?: string; abort: AbortSignal },
    ) => {
      // Native 1.19.5 forwards Tool.Context through the plugin bridge, although its
      // public SDK declaration omits callID. It is native context, never model input.
      if (typeof context.callID !== "string" || !context.callID || context.callID.length > 500)
        throw new Error("Native tool call identity is unavailable");
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/internal/tools`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([context.abort, AbortSignal.timeout(300_000)]),
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          sessionID: context.sessionID,
          messageID: context.messageID,
          callID: context.callID,
          tool: name,
          args,
        }),
      });
      const result = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message || "OpenNest tool failed");
      return name.startsWith("browser:") ? browserResult(result) : JSON.stringify(result);
    };
  const taskId = { taskId: tool.schema.string() };
  return {
    event: async ({ event }) => {
      relay?.capture(
        event as unknown as { type: string; properties: Record<string, unknown>; id?: string },
      );
    },
    tool: {
      ...browserPluginTools(call),
      codexnest_publish_artifact: tool({
        description:
          "Publish one standalone final deliverable. Never publish source references, intermediate files, plans or checklists.",
        args: { path: tool.schema.string(), label: tool.schema.string().optional() },
        execute: call("publish_artifact"),
      }),
      codexnest_spawn_task: tool({
        description:
          "Create an application-managed Team task. Completion automatically resumes the parent; do not poll.",
        args: {
          title: tool.schema.string(),
          prompt: tool.schema.string(),
          access: access.optional(),
          dependsOn: tool.schema.array(tool.schema.string()).optional(),
          reasoningEffort: tool.schema.string().optional(),
        },
        execute: call("spawn_task"),
      }),
      codexnest_list_tasks: tool({
        description:
          "One-time status for an explicit status request or a coordination decision. Never wait or poll with this tool.",
        args: {},
        execute: call("list_tasks"),
      }),
      codexnest_inspect_task: tool({
        description:
          "Inspect a delivered task or investigate a specific failure; never poll for completion.",
        args: taskId,
        execute: call("inspect_task"),
      }),
      codexnest_followup_task: tool({
        description: "Continue a delivered managed task in its existing conversation.",
        args: {
          ...taskId,
          prompt: tool.schema.string(),
          title: tool.schema.string().optional(),
          access: access.optional(),
          reasoningEffort: tool.schema.string().optional(),
        },
        execute: call("followup_task"),
      }),
      codexnest_steer_task: tool({
        description: "Send corrective guidance to an existing running managed task.",
        args: { ...taskId, message: tool.schema.string() },
        execute: call("steer_task"),
      }),
      codexnest_cancel_task: tool({
        description: "Cancel a queued or running managed task.",
        args: { ...taskId, reason: tool.schema.string().optional() },
        execute: call("cancel_task"),
      }),
      codexnest_integrate_task: tool({
        description:
          "Apply a delivered isolated task's changes after inspecting its result. Conflicts never overwrite parent changes.",
        args: taskId,
        execute: call("integrate_task"),
      }),
      codexnest_discard_task_changes: tool({
        description: "Explicitly discard a delivered task's unapplied isolated changes.",
        args: taskId,
        execute: call("discard_task_changes"),
      }),
      codexnest_submit_result: tool({
        description:
          "Before a managed child finishes, submit a concise result with checks and risks. Still send a normal final answer.",
        args: {
          summary: tool.schema.string(),
          outcome: tool.schema.enum(["success", "partial", "blocked", "failed"]),
          details: tool.schema.string().optional(),
          checks: tool.schema
            .array(
              tool.schema.object({
                name: tool.schema.string(),
                outcome: tool.schema.enum(["passed", "failed", "notRun"]),
                details: tool.schema.string().optional(),
              }),
            )
            .optional(),
          risks: tool.schema.array(tool.schema.string()).optional(),
          artifacts: tool.schema
            .array(
              tool.schema.object({
                label: tool.schema.string(),
                path: tool.schema.string().optional(),
                url: tool.schema.string().optional(),
              }),
            )
            .optional(),
        },
        execute: call("submit_result"),
      }),
      create_goal: tool({
        description:
          "Create a persistent goal only when explicitly requested by the user. Specify a budget only if requested.",
        args: {
          objective: tool.schema.string(),
          token_budget: tool.schema.number().int().positive().optional(),
        },
        execute: call("create_goal"),
      }),
      get_goal: tool({
        description: "Read the current goal and its observed usage.",
        args: {},
        execute: call("get_goal"),
      }),
      update_goal: tool({
        description:
          "Complete an achieved goal, block after repeated inability to proceed, or pause only at the user's explicit request.",
        args: { status: tool.schema.enum(["paused", "blocked", "complete"]) },
        execute: call("update_goal"),
      }),
    },
    "tool.execute.before": async (input, output) => {
      const policy = await readToolPolicy(stateDir, input.sessionID);
      if (policy)
        await enforceToolPolicy(policy, input.tool, output.args, join(stateDir, "tool-scopes"));
    },
  };
};

/** Preserve browser screenshots as native image attachments for vision models. */
export function browserResult(result: unknown): ToolResult {
  if (
    !result ||
    typeof result !== "object" ||
    !("content" in result) ||
    !Array.isArray(result.content)
  )
    return JSON.stringify(result);
  const attachments: Array<{ type: "file"; mime: string; url: string }> = [];
  const content = result.content.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") return entry;
    const block = entry as Record<string, unknown>;
    if (
      block.type !== "image" ||
      typeof block.data !== "string" ||
      typeof block.mimeType !== "string" ||
      !/^image\/[a-z0-9.+-]+$/i.test(block.mimeType)
    )
      return entry;
    attachments.push({
      type: "file",
      mime: block.mimeType,
      url: `data:${block.mimeType};base64,${block.data}`,
    });
    return { type: "text", text: "Screenshot attached." };
  });
  return attachments.length
    ? { output: JSON.stringify({ ...result, content }), attachments }
    : JSON.stringify(result);
}
