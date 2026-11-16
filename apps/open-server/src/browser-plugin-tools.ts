import { tool, type ToolContext, type ToolDefinition, type ToolResult } from "@opencode-ai/plugin";
import { BROWSER_TOOL_DEFINITIONS } from "./browser-tool-schema";

type Schema = InstanceType<typeof tool.schema.ZodType>;
type JsonSchema = Record<string, any>;

/** Translate only the schema vocabulary used by Nest's canonical browser tools. */
function field(schema: JsonSchema): Schema {
  let result: Schema;
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const values = schema.enum.map((value: any) => tool.schema.literal(value));
    result =
      values.length === 1
        ? values[0]!
        : tool.schema.union(values as unknown as [Schema, Schema, ...Schema[]]);
  } else if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    const values = schema.anyOf.map((value: JsonSchema) => field(value));
    result =
      values.length === 1
        ? values[0]!
        : tool.schema.union(values as unknown as [Schema, Schema, ...Schema[]]);
  } else if (schema.type === "object") {
    const value = tool.schema.object(shape(schema));
    result = schema.additionalProperties === false ? value.strict() : value.passthrough();
  } else if (schema.type === "array") {
    let value = tool.schema.array(field(schema.items ?? {}));
    if (typeof schema.minItems === "number") value = value.min(schema.minItems);
    if (typeof schema.maxItems === "number") value = value.max(schema.maxItems);
    result = value;
  } else if (schema.type === "string") result = tool.schema.string();
  else if (schema.type === "boolean") result = tool.schema.boolean();
  else if (schema.type === "null") result = tool.schema.null();
  else if (schema.type === "number" || schema.type === "integer") {
    let value = tool.schema.number();
    if (schema.type === "integer") value = value.int();
    if (typeof schema.minimum === "number") value = value.min(schema.minimum);
    if (typeof schema.maximum === "number") value = value.max(schema.maximum);
    result = value;
  } else result = tool.schema.unknown();
  return typeof schema.description === "string" ? result.describe(schema.description) : result;
}
function shape(schema: JsonSchema): Record<string, Schema> {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, value]) => {
      const entry = field(value as JsonSchema);
      return [name, required.has(name) ? entry : entry.optional()];
    }),
  );
}
export function browserPluginTools(
  call: (
    name: string,
  ) => (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>,
): Record<string, ToolDefinition> {
  return Object.fromEntries(
    BROWSER_TOOL_DEFINITIONS.map((definition) => [
      `browser_${definition.name}`,
      tool({
        description: definition.description,
        args: shape(definition.inputSchema),
        execute: call(`browser:${definition.name}`),
      }),
    ]),
  );
}
