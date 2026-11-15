import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Api } from "grammy";
import { createTools, type ToolDefinition } from "grammy-mcp";
import { Store } from "../store/store.js";
import { Reader } from "../store/read.js";
import { historyTools } from "./history-tools.js";
import { downloadFileTool } from "./file-tool.js";
import { formatTool } from "./format-tool.js";
import { type LocalTool, type ToolResult } from "./local-tool.js";

/**
 * Never exposed: they break the Worker's ownership of the update flow (getUpdates
 * conflicts with the webhook; the webhook is set by the admin route) or do something
 * to the bot that Telegram can't refuse.
 */
export const BLOCKED_TOOLS = [
  "getUpdates", "setWebhook", "deleteWebhook", "logOut", "close", "leaveChat",
];

export interface ServerOptions {
  api: Api;
  token: string;
  store: Store;
  reader: Reader;
  /** The caller's self-declared name, recorded on what it sends. */
  clientName: string | null;
  /** Filled in when a tool's chat_id is omitted. */
  defaultChatId?: string;
}

/**
 * Bot messages never come back as updates, so every successful call through `api` is
 * recorded: sends and edits as messages, deletes as deletions.
 */
function recordOutgoing(api: Api, o: ServerOptions, failures: string[]): void {
  api.config.use(async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    if (!response.ok) return response;
    const p = payload as Record<string, unknown>;
    try {
      if (method === "deleteMessage" || method === "deleteMessages") {
        const ids = method === "deleteMessage" ? [p.message_id] : (p.message_ids as unknown[]);
        const chatId = Number(p.chat_id);
        if (Number.isFinite(chatId)) await o.store.markDeleted(chatId, ids.map(Number));
      } else {
        await o.store.recordOutgoing(response.result, o.clientName);
      }
    } catch (error) {
      failures.push((error as Error).message);
    }
    return response;
  });
}

/** Make chat_id optional where the default chat can stand in for it. */
function withDefaultChat(definition: ToolDefinition, defaultChatId: string): ToolDefinition {
  const schema = definition.inputSchema;
  const required = (schema.required as string[] | undefined) ?? [];
  if (!required.includes("chat_id")) return definition;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  return {
    ...definition,
    inputSchema: {
      ...schema,
      required: required.filter((r) => r !== "chat_id"),
      properties: {
        ...properties,
        chat_id: {
          ...properties.chat_id,
          description: `${properties.chat_id.description ?? ""} Defaults to ${defaultChatId}.`.trim(),
        },
      },
    },
  };
}

export function buildServer(o: ServerOptions): Server {
  const failures: string[] = [];
  recordOutgoing(o.api, o, failures);

  const botTools = createTools(o.api, { deny: BLOCKED_TOOLS, fetchUrls: true });
  const chatTools = new Set<string>();
  const botDefinitions = botTools.definitions.map((definition) => {
    if (!o.defaultChatId) return definition;
    const adjusted = withDefaultChat(definition, o.defaultChatId);
    if (adjusted !== definition) chatTools.add(definition.name);
    return adjusted;
  });

  const local = new Map<string, LocalTool>(
    [...historyTools(o.reader), downloadFileTool(o.api, o.token), formatTool()]
      .map((t) => [t.definition.name, t]),
  );

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = local.get(name);
    if (tool) return tool.call(args);
    if (chatTools.has(name) && args.chat_id === undefined) {
      args = { ...args, chat_id: o.defaultChatId };
    }
    failures.length = 0;
    const result = await botTools.call(name, args);
    if (!result.isError && failures.length > 0) {
      // The call itself succeeded; say so rather than inviting a retry that double-sends.
      result.content.push({
        type: "text",
        text: `Warning: sent, but not recorded in history: ${failures.join("; ")}`,
      });
    }
    return result;
  }

  const server = new Server(
    { name: "telegram-gateway", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...botDefinitions, ...[...local.values()].map((t) => t.definition)],
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    (request) => call(request.params.name, request.params.arguments ?? {}),
  );
  return server;
}
