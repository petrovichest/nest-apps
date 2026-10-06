import {
  BROWSER_EXTENSION_PROTOCOL,
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  BROWSER_EXTENSION_WEBSOCKET_PATH,
  BROWSER_MAX_NETWORK_BODY_BYTES,
  BROWSER_MAX_TOOL_RESULT_BYTES,
  BROWSER_MAX_PROJECT_FILE_BYTES,
  BROWSER_MAX_WEBSOCKET_MESSAGE_BYTES,
  BROWSER_TOOL_RESULT_CHUNK_BYTES,
  BROWSER_NETWORK_CAPTURE_CHUNK_BYTES,
  BROWSER_TOOL_NAMES,
  isBrowserExtensionServerFrame,
} from "@codexnest/protocol";
import type {
  BrowserExtensionBindingSummary,
  BrowserExtensionClientFrame,
  BrowserExtensionProjectSummary,
  BrowserExtensionServerFrame,
  BrowserExtensionThreadSummary,
  BrowserNetworkCaptureFrame,
  BrowserProjectFileTransferDescriptor,
  BrowserSessionTarget,
  BrowserTabSummary as SharedBrowserTabSummary,
  BrowserToolName as SharedBrowserToolName,
  UiLanguage as SharedUiLanguage,
} from "@codexnest/protocol";

import { appName } from "./brand";

export const BROWSER_PROTOCOL = BROWSER_EXTENSION_PROTOCOL;
export const BROWSER_PROTOCOL_VERSION = BROWSER_EXTENSION_PROTOCOL_VERSION;
export const BROWSER_WEBSOCKET_PATH = BROWSER_EXTENSION_WEBSOCKET_PATH;
export const MAX_PROJECT_FILE_BYTES = BROWSER_MAX_PROJECT_FILE_BYTES;
export const MAX_NETWORK_BODY_BYTES = BROWSER_MAX_NETWORK_BODY_BYTES;
export const NETWORK_CAPTURE_CHUNK_BYTES = BROWSER_NETWORK_CAPTURE_CHUNK_BYTES;
export const MAX_TOOL_RESULT_BYTES = BROWSER_MAX_TOOL_RESULT_BYTES;
export const MAX_WEBSOCKET_MESSAGE_BYTES = BROWSER_MAX_WEBSOCKET_MESSAGE_BYTES;
export const TOOL_RESULT_CHUNK_BYTES = BROWSER_TOOL_RESULT_CHUNK_BYTES;
export const BROWSER_TOOLS = BROWSER_TOOL_NAMES;

export type UiLanguage = SharedUiLanguage;
export type ConnectionStatus = "pending" | "connecting" | "connected" | "reconnecting" | "error";
export type ProjectSummary = BrowserExtensionProjectSummary;
export type ThreadSummary = BrowserExtensionThreadSummary;
export type BrowserTabSummary = SharedBrowserTabSummary;
export type BindingSummary = BrowserExtensionBindingSummary;
export type BrowserToolName = SharedBrowserToolName;
export type SessionTarget = BrowserSessionTarget;
export type ProjectFileTransferDescriptor = BrowserProjectFileTransferDescriptor;
export type ClientFrame = BrowserExtensionClientFrame;
export type ServerFrame = BrowserExtensionServerFrame;
export type NetworkCaptureFrame = BrowserNetworkCaptureFrame;
export type ServerFileTransferFrame = Extract<ServerFrame, { type: "file.transfer" }>;

export interface CapturedImageDescriptor {
  kind: "captured_image";
  imageId: string;
  name?: string;
}

export type UploadDescriptor = CapturedImageDescriptor | ProjectFileTransferDescriptor;

export function browserWebSocketUrl(baseUrl: string): string {
  const url = new URL(BROWSER_WEBSOCKET_PATH, `${normaliseBaseUrl(baseUrl)}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function normaliseBaseUrl(value: string): string {
  const candidate = value.trim();
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(candidate)
    ? candidate
    : `http://${candidate}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${appName} URL must use HTTP or HTTPS`);
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export const isServerFrame = isBrowserExtensionServerFrame;

export function browserToolResultFrames(requestId: string, result: unknown): ClientFrame[] {
  const serialized = JSON.stringify(result ?? null);
  const encodedBytes = new TextEncoder().encode(serialized).byteLength;
  const normal: ClientFrame = { type: "tool.result", requestId, result };
  if (new TextEncoder().encode(JSON.stringify(normal)).byteLength <= MAX_WEBSOCKET_MESSAGE_BYTES) {
    return [normal];
  }
  if (encodedBytes > MAX_TOOL_RESULT_BYTES) {
    throw new Error("Browser tool result exceeds the 8 MB transfer limit");
  }
  const chunks = splitToolResult(requestId, serialized);
  return chunks.map((data, chunkIndex) => ({
    type: "tool.result.chunk",
    requestId,
    chunkIndex,
    chunkCount: chunks.length,
    data,
  }));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitToolResult(requestId: string, value: string): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let low = offset + 1;
    let high = Math.min(value.length, offset + TOOL_RESULT_CHUNK_BYTES);
    let end = offset;
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      let candidateEnd = midpoint;
      if (candidateEnd < value.length && isHighSurrogate(value.charCodeAt(candidateEnd - 1))) {
        candidateEnd -= 1;
      }
      if (candidateEnd <= offset) {
        low = midpoint + 1;
        continue;
      }
      const data = value.slice(offset, candidateEnd);
      const dataBytes = encoder.encode(data).byteLength;
      const frameBytes = encoder.encode(
        JSON.stringify({
          type: "tool.result.chunk",
          requestId,
          chunkIndex: 9_999,
          chunkCount: 9_999,
          data,
        }),
      ).byteLength;
      if (dataBytes <= TOOL_RESULT_CHUNK_BYTES && frameBytes <= MAX_WEBSOCKET_MESSAGE_BYTES) {
        end = candidateEnd;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    if (end <= offset) throw new Error("Unable to split browser tool result");
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}
