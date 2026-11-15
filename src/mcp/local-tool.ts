import { Validator, type Schema as JsonSchema } from "@cfworker/json-schema";
import type { ToolDefinition } from "grammy-mcp";

/** An MCP tool result; content blocks may be text, image or resource. */
export interface ToolResult {
  [key: string]: unknown;
  content: Record<string, unknown>[];
  isError?: boolean;
}

/** A tool implemented by the gateway itself, served next to the generated Bot API tools. */
export interface LocalTool {
  definition: ToolDefinition;
  call(args: Record<string, unknown>): Promise<ToolResult>;
}

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function text(t: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: "text", text: t }], isError: true }
    : { content: [{ type: "text", text: t }] };
}

/** Validates arguments against the definition, and turns thrown errors into tool errors. */
export function localTool(
  definition: ToolDefinition,
  run: (args: Record<string, unknown>) => Promise<ToolResult | string>,
): LocalTool {
  const validator = new Validator(definition.inputSchema as JsonSchema, "2020-12");
  return {
    definition,
    async call(args) {
      const check = validator.validate(args);
      if (!check.valid) {
        const errors = check.errors.map((e) => `${e.instanceLocation}: ${e.error}`);
        return text(`Invalid arguments for ${definition.name}:\n${errors.join("\n")}`, true);
      }
      try {
        const result = await run(args);
        return typeof result === "string" ? text(result) : result;
      } catch (error) {
        return text((error as Error).message, true);
      }
    },
  };
}
