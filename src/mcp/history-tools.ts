import { Reader } from "../store/read.js";
import { formatChat, formatMessage, formatMessages } from "../store/format.js";
import { type LocalTool, localTool, READ_ONLY } from "./local-tool.js";

const chatId = {
  anyOf: [{ type: "integer" }, { type: "string" }],
  description: "Chat id (e.g. -5595413740) or @username",
};
const when = {
  anyOf: [{ type: "number" }, { type: "string" }],
  description: "Unix seconds or an ISO 8601 time (e.g. 2026-11-26T08:00:00-09:00)",
};
const integer = (extra: Record<string, unknown> = {}) => ({ type: "integer", ...extra });

function object(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

type ChatRef = number | string;

function toUnix(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Unrecognized time: ${value}`);
  return Math.floor(ms / 1000);
}

export function historyTools(reader: Reader): LocalTool[] {
  const chats = localTool({
    name: "historyChats",
    description:
      "List every chat the bot has seen, most recently active first, with message counts. History tools " +
      "read the gateway's own record of the chat (the Bot API itself has no history).",
    inputSchema: object({}),
    annotations: READ_ONLY,
  }, async () => (await reader.chats()).map(formatChat).join("\n") || "No chats yet.");

  const messages = localTool({
    name: "historyMessages",
    description:
      "Read stored messages, both incoming and the bot's own, oldest first. Two modes: " +
      "(1) with after_seq: everything recorded after that cursor (new messages and edits), for following " +
      "a chat across sessions — keep the returned next after_seq; " +
      "(2) without it: the latest `limit` messages, optionally bounded by since/until/before_message_id. " +
      "Each line: [seq] time #message_id ↩#replied_to sender (user id) [bot, sent via gateway by client]: text [media file_id=…]. " +
      "Only the current version of an edited message is shown; historyMessage shows earlier versions.",
    inputSchema: object({
      chat_id: { ...chatId, description: "Chat id or @username; omit for all chats" },
      after_seq: integer({ minimum: 0, description: "Cursor: return rows recorded after this seq" }),
      before_message_id: integer({ description: "Only messages with a lower message_id (paging back)" }),
      since: when,
      until: when,
      limit: integer({ minimum: 1, maximum: 200, description: "Default 50" }),
    }),
    annotations: READ_ONLY,
  }, async (args) => {
    const p = args as {
      chat_id?: ChatRef; after_seq?: number; before_message_id?: number;
      since?: number | string; until?: number | string; limit?: number;
    };
    const limit = p.limit ?? 50;
    const rows = await reader.messages({
      chatId: p.chat_id,
      afterSeq: p.after_seq,
      beforeMessageId: p.before_message_id,
      since: toUnix(p.since),
      until: toUnix(p.until),
      limit,
    });
    const body = rows.length > 0 ? formatMessages(rows) : "No messages.";
    if (p.after_seq !== undefined) {
      const next = rows.length > 0 ? rows[rows.length - 1].id : p.after_seq;
      const status = rows.length === limit ? "more available" : "caught up";
      return `${body}\n\n(${status}; next after_seq=${next})`;
    }
    return `${body}\n\n(latest seq=${await reader.latestSeq()}; pass it as after_seq to follow new messages)`;
  });

  const message = localTool({
    name: "historyMessage",
    description:
      "One message in context: the chain of messages it replies to, the message itself with any earlier " +
      "versions (edits), and the direct replies to it.",
    inputSchema: object({
      chat_id: chatId,
      message_id: integer(),
      context: integer({ minimum: 0, maximum: 20, description: "How many replied-to ancestors to show (default 5)" }),
    }, ["chat_id", "message_id"]),
    annotations: READ_ONLY,
  }, async (args) => {
    const p = args as { chat_id: ChatRef; message_id: number; context?: number };
    const chat = await reader.resolveChat(p.chat_id);
    const versions = await reader.versions(chat, p.message_id);
    if (versions.length === 0) return `No stored message ${p.message_id} in chat ${p.chat_id}.`;
    const current = versions[versions.length - 1];

    const ancestors: string[] = [];
    let parentId = current.reply_to_message_id;
    while (parentId !== null && ancestors.length < (p.context ?? 5)) {
      const parent = (await reader.versions(chat, parentId)).pop();
      if (!parent) {
        ancestors.unshift(`#${parentId} (not stored)`);
        break;
      }
      ancestors.unshift(formatMessage(parent, false));
      parentId = parent.reply_to_message_id;
    }

    const sections = [];
    if (ancestors.length > 0) sections.push(`In reply to:\n${ancestors.join("\n")}`);
    sections.push(`Message:\n${formatMessage(current, false)}`);
    if (versions.length > 1) {
      sections.push(`Earlier versions:\n${versions.slice(0, -1).map((m) => formatMessage(m, false)).join("\n")}`);
    }
    const replies = await reader.replies(chat, p.message_id);
    sections.push(replies.length > 0 ? `Replies:\n${formatMessages(replies)}` : "Replies: none");
    return sections.join("\n\n");
  });

  const replies = localTool({
    name: "historyReplies",
    description: "Direct replies to a message, oldest first.",
    inputSchema: object({ chat_id: chatId, message_id: integer() }, ["chat_id", "message_id"]),
    annotations: READ_ONLY,
  }, async (args) => {
    const p = args as { chat_id: ChatRef; message_id: number };
    const rows = await reader.replies(await reader.resolveChat(p.chat_id), p.message_id);
    return rows.length > 0 ? formatMessages(rows) : "No replies.";
  });

  const search = localTool({
    name: "historySearch",
    description:
      "Full-text search over stored message text, captions and sender names, best match first. " +
      "Accepts SQLite FTS5 syntax (prefix*, \"exact phrase\", OR, NOT); anything else is searched as plain words.",
    inputSchema: object({
      query: { type: "string", minLength: 1 },
      chat_id: { ...chatId, description: "Limit to one chat" },
      limit: integer({ minimum: 1, maximum: 100, description: "Default 20" }),
    }, ["query"]),
    annotations: READ_ONLY,
  }, async (args) => {
    const p = args as { query: string; chat_id?: ChatRef; limit?: number };
    const rows = await reader.search(p.query, p.chat_id, p.limit ?? 20);
    return rows.length > 0 ? rows.map((m) => formatMessage(m, true)).join("\n") : "No matches.";
  });

  return [chats, messages, message, replies, search];
}
