import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Reader } from "../store/read.js";
import { formatChat, formatMessage, formatMessages } from "../store/format.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const chatId = z.union([z.number().int(), z.string()])
  .describe("Chat id (e.g. -5595413740) or @username");
const when = z.union([z.number(), z.string()])
  .describe("Unix seconds or an ISO 8601 time (e.g. 2026-11-26T08:00:00-09:00)");

function toUnix(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Unrecognized time: ${value}`);
  return Math.floor(ms / 1000);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

async function guarded(fn: () => Promise<string>) {
  try {
    return text(await fn());
  } catch (error) {
    return { ...text((error as Error).message), isError: true };
  }
}

export function registerHistoryTools(server: McpServer, reader: Reader): void {
  server.tool(
    "history_chats",
    "List every chat the bot has seen, most recently active first, with message counts. History tools " +
      "read the gateway's own record of the chat (the Bot API itself has no history).",
    {},
    READ_ONLY,
    () => guarded(async () => (await reader.chats()).map(formatChat).join("\n") || "No chats yet.")
  );

  server.tool(
    "history_messages",
    "Read stored messages, both incoming and the bot's own, oldest first. Two modes: " +
      "(1) with after_seq: everything recorded after that cursor (new messages and edits), for following " +
      "a chat across sessions — keep the returned next after_seq; " +
      "(2) without it: the latest `limit` messages, optionally bounded by since/until/before_message_id. " +
      "Each line: [seq] time #message_id ↩#replied_to sender (user id) [bot, sent via gateway by client]: text [media file_id=…]. " +
      "Only the current version of an edited message is shown; history_message shows earlier versions.",
    {
      chat_id: chatId.optional().describe("Chat id or @username; omit for all chats"),
      after_seq: z.number().int().min(0).optional().describe("Cursor: return rows recorded after this seq"),
      before_message_id: z.number().int().optional().describe("Only messages with a lower message_id (paging back)"),
      since: when.optional(),
      until: when.optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
    },
    READ_ONLY,
    (p) => guarded(async () => {
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
    })
  );

  server.tool(
    "history_message",
    "One message in context: the chain of messages it replies to, the message itself with any earlier " +
      "versions (edits), and the direct replies to it.",
    {
      chat_id: chatId,
      message_id: z.number().int(),
      context: z.number().int().min(0).max(20).optional().describe("How many replied-to ancestors to show (default 5)"),
    },
    READ_ONLY,
    (p) => guarded(async () => {
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
    })
  );

  server.tool(
    "history_replies",
    "Direct replies to a message, oldest first.",
    { chat_id: chatId, message_id: z.number().int() },
    READ_ONLY,
    (p) => guarded(async () => {
      const rows = await reader.replies(await reader.resolveChat(p.chat_id), p.message_id);
      return rows.length > 0 ? formatMessages(rows) : "No replies.";
    })
  );

  server.tool(
    "history_search",
    "Full-text search over stored message text, captions and sender names, best match first. " +
      "Accepts SQLite FTS5 syntax (prefix*, \"exact phrase\", OR, NOT); anything else is searched as plain words.",
    {
      query: z.string().min(1),
      chat_id: chatId.optional().describe("Limit to one chat"),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
    },
    READ_ONLY,
    (p) => guarded(async () => {
      const rows = await reader.search(p.query, p.chat_id, p.limit ?? 20);
      return rows.length > 0 ? rows.map((m) => formatMessage(m, true)).join("\n") : "No matches.";
    })
  );
}
