import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Config } from "../core/config.js";
import { TelegramClient, TelegramApiError } from "../telegram/telegram-client.js";
import { MethodDef, buildZodSchema } from "./method-registry.js";
import { allMethods } from "./methods/index.js";
import { CircuitOpenError } from "../core/circuit-breaker.js";
import { FORMATS, findFormat, formatIndex } from "./formats.js";

/** Pre-built Zod schemas for all methods (built once, reused on every call). */
const schemaCache = new Map<string, ReturnType<typeof buildZodSchema>>();

function getSchema(
  method: MethodDef,
  defaultChatId?: string
): ReturnType<typeof buildZodSchema> {
  const cacheKey = defaultChatId ? `${method.apiMethod}:default-chat` : method.apiMethod;
  let schema = schemaCache.get(cacheKey);
  if (!schema) {
    schema = buildZodSchema(method.params, { defaultChatId });
    schemaCache.set(cacheKey, schema);
  }
  return schema;
}

/** Build a fully-registered MCP server + its Telegram client (transport-agnostic). */
export function buildServer(config: Config): { server: McpServer; client: TelegramClient } {
  const client = new TelegramClient(config);

  const server = new McpServer({
    name: "telegram-gateway",
    version: "0.1.0",
  });

  registerAllTools(server, client, config);
  registerFormatTool(server);

  return { server, client };
}

function registerAllTools(server: McpServer, client: TelegramClient, config: Config): void {
  for (const method of allMethods) {
    const zodSchema = getSchema(method, config.defaultChatId);

    const annotations = method.annotations || { destructiveHint: false };

    server.tool(
      method.toolName,
      method.description,
      zodSchema.shape,
      annotations,
      async (params) => {
        return callTelegram(client, method, params as Record<string, unknown>);
      }
    );
  }
}

// ─── Formats ───────────────────────────────────────────────────────────

/**
 * A JSON Schema can say `rich_message: object`; it cannot teach an agent what a rich
 * post is or how its markdown works. This tool answers that question before anything
 * is sent, so a malformed post never reaches a channel to find out.
 */
function registerFormatTool(server: McpServer): void {
  server.tool(
    "telegram_format",
    "Ask what shape a structured Telegram parameter must have BEFORE sending. Call this whenever you " +
      "are about to build a rich post, an album, a keyboard, or a poll and are not certain of the exact " +
      "syntax. Topics: " + FORMATS.map((f) => f.topic).join(", ") + ". Omit the topic to list them all. " +
      "For a post longer than a 1024-character caption, ask for 'rich_message'.",
    {
      topic: z.string().optional().describe(
        "Format to explain — a topic ('rich_message', 'media', 'reply_markup', 'poll'), a tool name " +
        "('send_rich_message', 'send_media_group'), or plain wording ('long post', 'table', 'album', 'buttons')"
      ),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (params) => {
      if (!params.topic) {
        return { content: [{ type: "text" as const, text: formatIndex() }] };
      }
      const doc = findFormat(params.topic);
      if (!doc) {
        return {
          content: [{ type: "text" as const, text: `No format named "${params.topic}".\n\n${formatIndex()}` }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: `${doc.body}\n\n---\nApplies to: ${doc.applies}`,
        }],
      };
    }
  );

  for (const doc of FORMATS) {
    server.resource(
      `format-${doc.topic}`,
      `telegram://format/${doc.topic}`,
      { description: doc.summary, mimeType: "text/markdown" },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: doc.body }],
      })
    );
  }
}

// ─── Execution ──────────────────────────────────────────────────────────

/** Params arrive already validated by the SDK. */
async function callTelegram(
  client: TelegramClient,
  method: MethodDef,
  params: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    const result = await client.call(method.apiMethod, params);
    const text = formatResult(method.apiMethod, result);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    const message = error instanceof CircuitOpenError
      ? error.message
      : error instanceof TelegramApiError
        ? error.message
        : `Unexpected error: ${(error as Error).message}`;

    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}

const MAX_RESPONSE_LENGTH = 100_000;

function formatResult(method: string, result: unknown): string {
  if (result === true) return `${method}: Success`;

  let text: string;
  if (typeof result === "object" && result !== null) {
    text = JSON.stringify(result, null, 2);
  } else {
    text = String(result);
  }

  // Truncate to prevent filling context window
  if (text.length > MAX_RESPONSE_LENGTH) {
    text = text.slice(0, MAX_RESPONSE_LENGTH) + `\n\n... [truncated, ${text.length} chars total]`;
  }

  return text;
}
