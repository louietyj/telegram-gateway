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

/** Sent at initialize: what a client can't learn from the tool list alone. */
export const INSTRUCTIONS = `\
Telegram through a gateway that stores every message both ways. The Bot API has no history; this store is the record.

Reading: historyMessages with after_seq returns everything recorded since that cursor, oldest first (edits are new rows); keep the cursor it reports. Nothing is consumed, so every reader keeps its own. Never getUpdates (blocked).

Watching without polling: open a WebSocket to /stream on the same host as this endpoint (wss://), with the same Authorization header. Read-only.
- It pushes every update Telegram delivers, verbatim, and every non-get* Bot API call made through the gateway, in seq order. The gateway filters nothing: filter in your client.
- Query: after_seq=N to resume, since=<unix> to start at a time, neither to start now. This seq is the stream's own, not historyMessages' after_seq.
- First frame: {"type":"hello","after_seq":N,"latest_seq":M}; seqs up to M are replay, then it's live. Reconnecting with the last seq you saw misses nothing and repeats nothing.
- {"type":"event","seq","time","source":"telegram","update":{...},"_gateway_meta":{"is_mention","reply_to_from_bot"}}: _gateway_meta is the only thing the gateway adds, and only for updates carrying a message.
- {"type":"event","seq","time","source":"gateway","client","call":{"method","params","result"}}: the bot's own sends, edits and deletes. Telegram never reports other people's deletes.`;

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
 * recorded (Store.recordCall).
 */
function recordOutgoing(api: Api, o: ServerOptions, failures: string[]): void {
  api.config.use(async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    if (!response.ok) return response;
    try {
      await o.store.recordCall(method, payload as Record<string, unknown>, response.result, o.clientName);
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
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
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
