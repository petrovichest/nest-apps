import { createHmac, timingSafeEqual } from "node:crypto";
import { SESSION_MCP_NAME } from "@codexnest/protocol";
import { AppError, record, UUID_PATTERN } from "./types";

export const PUBLISH_ARTIFACT_TOOL = {
  name: "publish_artifact",
  description:
    "Publish one standalone final file to the user in this session. Use only for intentional deliverables, never source references, intermediate files, plans, or checklists.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", maxLength: 4096, description: "Path to one file in the workspace." },
      label: { type: "string", maxLength: 500, description: "Optional user-facing label." },
    },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

export const publishArtifactToolName = `mcp__${SESSION_MCP_NAME}__${PUBLISH_ARTIFACT_TOOL.name}`;

const grantField = "__nestArtifactGrant";
type ArtifactInput = { path: string; label?: string };

export function artifactSessionKey(token: string, threadId: string): string {
  return createHmac("sha256", token).update(`opennest-artifact\0${threadId}`).digest("hex");
}

function artifactInput(value: unknown): ArtifactInput {
  const { path, label, ...extra } = record(value);
  if (Object.keys(extra).length)
    throw new AppError("invalid_request", "publish_artifact accepts only path and label");
  if (typeof path !== "string" || !path.trim() || path.length > 4096 || path.includes("\0"))
    throw new AppError("invalid_request", "Provide a valid artifact path");
  if (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 500))
    throw new AppError("invalid_request", "label must be nonempty text of at most 500 characters");
  return { path, ...(label === undefined ? {} : { label: label.trim() }) };
}

function signature(
  key: string,
  toolUseId: string,
  input: ArtifactInput,
  turnId: string,
  createdAt: number,
): string {
  return createHmac("sha256", key)
    .update(JSON.stringify([toolUseId, input.path, input.label ?? null, turnId, createdAt]))
    .digest("hex");
}

// Claude's HTTP MCP connection is also available to native subagents. Only the
// runner's main-session hook can issue a grant, using a key kept out of MCP config.
export function grantArtifactCall(key: string, toolUseId: string, turnId: string, args: unknown) {
  const input = artifactInput(args);
  const createdAt = Date.now();
  return {
    ...input,
    [grantField]: {
      turnId,
      createdAt,
      signature: signature(key, toolUseId, input, turnId, createdAt),
    },
  };
}

export function authorizeArtifactCall(key: string, args: unknown, metadata: unknown) {
  const { [grantField]: grant, ...value } = record(args);
  const toolUseId =
    metadata &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>)["claudecode/toolUseId"];
  const denied = () =>
    new AppError("forbidden", "Publish from the main Claude session using its artifact tool", 403);
  if (
    typeof toolUseId !== "string" ||
    !toolUseId ||
    toolUseId.length > 256 ||
    !grant ||
    typeof grant !== "object" ||
    Array.isArray(grant)
  )
    throw denied();
  const { turnId, createdAt, signature: supplied } = record(grant);
  const now = Date.now();
  if (
    typeof turnId !== "string" ||
    !UUID_PATTERN.test(turnId) ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt > now ||
    now - createdAt > 60_000 ||
    typeof supplied !== "string" ||
    !/^[a-f\d]{64}$/.test(supplied)
  )
    throw denied();
  const input = artifactInput(value);
  const expected = signature(key, toolUseId, input, turnId, createdAt);
  if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw denied();
  return { ...input, turnId, createdAt };
}
