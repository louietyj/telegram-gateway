import { D1Like } from "./db.js";

export interface StoredMessage {
  id: number;
  chat_id: number;
  message_id: number;
  version: number;
  date: number;
  edit_date: number | null;
  deleted_at: number | null;
  from_id: number | null;
  from_name: string | null;
  from_username: string | null;
  is_bot: number;
  outgoing: number;
  client: string | null;
  reply_to_message_id: number | null;
  kind: string;
  text: string | null;
  media: string | null;
}

export interface StoredChat {
  chat_id: number;
  type: string | null;
  title: string | null;
  username: string | null;
  migrated_to: number | null;
  bot_status: string | null;
  messages: number;
  last_date: number | null;
}

export interface MessageQuery {
  chatId?: number | string;
  /** Cursor mode: rows recorded after this seq, oldest first. */
  afterSeq?: number;
  beforeMessageId?: number;
  since?: number;
  until?: number;
  limit: number;
}

const COLUMNS = `id, chat_id, message_id, version, date, edit_date, deleted_at, from_id, from_name,
  from_username, is_bot, outgoing, client, reply_to_message_id, kind, text, media`;

const placeholders = (n: number) => Array(n).fill("?").join(",");

export class Reader {
  constructor(private db: D1Like) {}

  /** A chat plus every id it had before or after a group→supergroup upgrade. */
  async chatFamily(chat: number | string): Promise<number[]> {
    const chatId = await this.resolveChat(chat);
    const { results } = await this.db.prepare(
      `WITH RECURSIVE fam(id) AS (
         SELECT ?1
         UNION SELECT c.chat_id FROM chats c JOIN fam ON c.migrated_to = fam.id
         UNION SELECT c.migrated_to FROM chats c JOIN fam ON c.chat_id = fam.id WHERE c.migrated_to IS NOT NULL
       ) SELECT id FROM fam`
    ).bind(chatId).all<{ id: number }>();
    return results.map((r) => r.id);
  }

  /** Accept a numeric id (number or string) or an @username the bot has seen. */
  async resolveChat(chat: number | string): Promise<number> {
    if (typeof chat === "number") return chat;
    if (/^-?\d+$/.test(chat)) return Number(chat);
    const row = await this.db.prepare("SELECT chat_id FROM chats WHERE username = ? COLLATE NOCASE")
      .bind(chat.replace(/^@/, "")).first<{ chat_id: number }>();
    if (!row) throw new Error(`No known chat ${chat}. Use historyChats to list chats.`);
    return row.chat_id;
  }

  async chats(): Promise<StoredChat[]> {
    const { results } = await this.db.prepare(
      `SELECT c.chat_id, c.type, c.title, c.username, c.migrated_to, c.bot_status,
         (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.superseded = 0) AS messages,
         (SELECT MAX(date) FROM messages m WHERE m.chat_id = c.chat_id) AS last_date
       FROM chats c ORDER BY last_date DESC NULLS LAST`
    ).all<StoredChat>();
    return results;
  }

  async messages(q: MessageQuery): Promise<StoredMessage[]> {
    const where = ["superseded = 0"];
    const args: unknown[] = [];
    if (q.chatId !== undefined) {
      const family = await this.chatFamily(q.chatId);
      where.push(`chat_id IN (${placeholders(family.length)})`);
      args.push(...family);
    }
    if (q.afterSeq !== undefined) { where.push("id > ?"); args.push(q.afterSeq); }
    if (q.beforeMessageId !== undefined) { where.push("message_id < ?"); args.push(q.beforeMessageId); }
    if (q.since !== undefined) { where.push("date >= ?"); args.push(q.since); }
    if (q.until !== undefined) { where.push("date < ?"); args.push(q.until); }

    const cursorMode = q.afterSeq !== undefined;
    const order = cursorMode ? "id ASC" : "date DESC, id DESC";
    const { results } = await this.db.prepare(
      `SELECT ${COLUMNS} FROM messages WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`
    ).bind(...args, q.limit).all<StoredMessage>();
    return cursorMode ? results : results.reverse();
  }

  /** All versions of one message, oldest first (the last is current). */
  async versions(chatId: number, messageId: number): Promise<StoredMessage[]> {
    const family = await this.chatFamily(chatId);
    const { results } = await this.db.prepare(
      `SELECT ${COLUMNS} FROM messages WHERE chat_id IN (${placeholders(family.length)}) AND message_id = ?
       ORDER BY version`
    ).bind(...family, messageId).all<StoredMessage>();
    return results;
  }

  async replies(chatId: number, messageId: number): Promise<StoredMessage[]> {
    const family = await this.chatFamily(chatId);
    const { results } = await this.db.prepare(
      `SELECT ${COLUMNS} FROM messages WHERE chat_id IN (${placeholders(family.length)})
         AND reply_to_message_id = ? AND superseded = 0 ORDER BY date, id`
    ).bind(...family, messageId).all<StoredMessage>();
    return results;
  }

  /** FTS5 search, best match first. A query that isn't valid FTS5 syntax is retried as plain words. */
  async search(query: string, chatId: number | string | undefined, limit: number): Promise<StoredMessage[]> {
    const run = async (match: string) => {
      const args: unknown[] = [match];
      let chatFilter = "";
      if (chatId !== undefined) {
        const family = await this.chatFamily(chatId);
        chatFilter = `AND m.chat_id IN (${placeholders(family.length)})`;
        args.push(...family);
      }
      const { results } = await this.db.prepare(
        `SELECT ${COLUMNS.replace(/(\w+)/g, "m.$1")} FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ? AND m.superseded = 0 ${chatFilter} ORDER BY f.rank LIMIT ?`
      ).bind(...args, limit).all<StoredMessage>();
      return results;
    };
    try {
      return await run(query);
    } catch {
      const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (words.length === 0) return [];
      return run(words.map((w) => `"${w}"`).join(" "));
    }
  }

  async latestSeq(): Promise<number> {
    const row = await this.db.prepare("SELECT MAX(id) AS seq FROM messages").first<{ seq: number | null }>();
    return row?.seq ?? 0;
  }
}
