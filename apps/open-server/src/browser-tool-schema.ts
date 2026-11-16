import {
  BROWSER_TOOL_NAMES,
  BROWSER_MAX_NETWORK_BODY_READ_BYTES,
  type BrowserToolName,
} from "@codexnest/protocol";
type ServerBrowserToolName = BrowserToolName;
const MAX_NETWORK_BODY_READ_BYTES = BROWSER_MAX_NETWORK_BODY_READ_BYTES;

export const BROWSER_TOOL_DEFINITIONS = BROWSER_TOOL_NAMES.map((name) => ({
  name,
  description: browserToolDescription(name),
  inputSchema: browserToolInputSchema(name),
}));

export function browserToolDescription(name: ServerBrowserToolName): string {
  const descriptions: Record<ServerBrowserToolName, string> = {
    tabs_context: "List browser tabs and identify the active tab.",
    tabs_create: "Create a browser tab.",
    tabs_close: "Close one or more browser tabs.",
    navigate: "Navigate a browser tab to a URL or through history.",
    computer: "Interact with the page using mouse and keyboard actions.",
    read_page: "Read the current page accessibility structure.",
    get_page_text: "Get visible text from the current page.",
    find: "Find text in the current page.",
    form_input: "Set a value on a page form control.",
    javascript_tool: "Execute JavaScript in the current page.",
    read_console_messages: "Read browser console messages.",
    read_network_requests:
      "List complete browser network exchanges. Protocol v2 reads the server capture store; v1 Chrome uses the extension fallback.",
    read_network_request:
      "Read one complete server-stored network exchange and its request/response body references.",
    read_network_body:
      "Read a byte range from a server-stored request or response body (at most 512 KiB).",
    resize_window: "Resize the browser window.",
    upload_file: "Upload a workspace file through a page file input.",
  };
  return descriptions[name];
}

export function browserToolInputSchema(name: ServerBrowserToolName): Record<string, unknown> {
  const tabId = {
    type: "integer",
    minimum: 0,
    description: "Browser tab ID; defaults to the active tab.",
  };
  const schemas: Record<ServerBrowserToolName, Record<string, unknown>> = {
    tabs_context: objectSchema({}),
    tabs_create: objectSchema({
      url: { type: "string", description: "URL to open; defaults to about:blank." },
      active: { type: "boolean", description: "Whether to activate the new tab." },
      tabId,
    }),
    tabs_close: objectSchema({
      tabId,
      tabIds: { type: "array", items: { type: "integer", minimum: 0 } },
    }),
    navigate: objectSchema({
      tabId,
      action: { type: "string", enum: ["url", "back", "forward", "reload"] },
      url: { type: "string", description: "Required when action is url." },
      bypassCache: { type: "boolean" },
    }),
    computer: objectSchema(
      {
        tabId,
        action: {
          type: "string",
          enum: [
            "screenshot",
            "wait",
            "zoom",
            "scroll_to",
            "type",
            "key",
            "scroll",
            "hover",
            "click",
            "drag",
          ],
        },
        ref: { type: "string", description: "Element ref returned by read_page or find." },
        x: { type: "number" },
        y: { type: "number" },
        text: { type: "string" },
        key: { type: "string", description: "Key or shortcut such as Enter or Control+L." },
        button: { type: "string", enum: ["left", "middle", "right"] },
        count: { type: "integer", minimum: 1, maximum: 3 },
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        amount: { type: "number" },
        milliseconds: { type: "number", minimum: 0, maximum: 30_000 },
        duration: { type: "number", minimum: 0, maximum: 30_000 },
        factor: { type: "number", minimum: 0.25, maximum: 5 },
        fromX: { type: "number" },
        fromY: { type: "number" },
        toX: { type: "number" },
        toY: { type: "number" },
      },
      ["action"],
    ),
    read_page: objectSchema({ tabId, maxChars: boundedIntegerSchema(1_000, 100_000) }),
    get_page_text: objectSchema({ tabId, maxChars: boundedIntegerSchema(1_000, 500_000) }),
    find: objectSchema(
      {
        tabId,
        query: { type: "string" },
        selector: { type: "string", description: "Optional CSS selector." },
        maxResults: boundedIntegerSchema(1, 200),
      },
      ["query"],
    ),
    form_input: objectSchema(
      {
        tabId,
        ref: { type: "string" },
        value: {},
      },
      ["ref", "value"],
    ),
    javascript_tool: objectSchema(
      {
        tabId,
        code: { type: "string", description: "JavaScript expression evaluated in the page." },
      },
      ["code"],
    ),
    read_console_messages: objectSchema({
      tabId,
      since: { type: "number", description: "Unix timestamp in milliseconds." },
      level: { type: "string" },
      search: { type: "string" },
      limit: boundedIntegerSchema(1, 1_000),
    }),
    read_network_requests: objectSchema({
      tabId,
      since: { type: "number", description: "Unix timestamp in milliseconds." },
      search: { type: "string" },
      limit: boundedIntegerSchema(1, 1_000),
    }),
    read_network_request: objectSchema(
      {
        exchangeId: {
          type: "string",
          description: "Exchange ID returned by read_network_requests.",
        },
      },
      ["exchangeId"],
    ),
    read_network_body: objectSchema(
      {
        bodyId: { type: "string", description: "Body ID returned by read_network_request." },
        offset: { type: "integer", minimum: 0, description: "Zero-based byte offset." },
        length: {
          type: "integer",
          minimum: 1,
          maximum: MAX_NETWORK_BODY_READ_BYTES,
          description: "Number of bytes to read; defaults to 512 KiB.",
        },
      },
      ["bodyId"],
    ),
    resize_window: objectSchema({
      tabId,
      width: boundedIntegerSchema(320, 10_000),
      height: boundedIntegerSchema(240, 10_000),
    }),
    upload_file: {
      ...objectSchema(
        {
          tabId,
          ref: { type: "string", description: "File input or drop-target element ref." },
          path: {
            type: "string",
            description: "Absolute or thread-relative project file path, at most 100 MB.",
          },
          imageId: { type: "string", description: "Captured screenshot imageId." },
          name: { type: "string", description: "Optional filename for a captured image." },
          drop: { type: "boolean", description: "Use drag-and-drop instead of a file input." },
        },
        ["ref"],
      ),
      anyOf: [{ required: ["path"] }, { required: ["imageId"] }],
    },
  };
  return schemas[name];
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function boundedIntegerSchema(minimum: number, maximum: number): Record<string, unknown> {
  return { type: "integer", minimum, maximum };
}
