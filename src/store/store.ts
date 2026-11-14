import { D1Like, D1StatementLike } from "./db.js";
import { chatRow, isMessage, messageRow } from "./normalize.js";

type Json = Record<string, unknown>;

/** Update fields that carry a Message we store. */
const MESSAGE_UPDATE_FIELDS = [
  "message", "edited_message", "channel_post", "edited_channel_post",
  "business_message", "edited_business_message",
] as const;

export interface Provenance {
  /** The update that delivered it (incoming) — makes redelivery a no-op. */
  updateId?: number;
  /** Sent through this Worker. */
  outgoing?: boolean;
  client?: string | null;
}

const now = () => Math.floor(Date.now() / 1000);

export class Store {
  constructor(private db: D1Like) {}

  /** Store one webhook/backfill update. Idempotent: a redelivered update changes nothing. */
  async ingestUpdate(update: Json, source: "webhook" | "backfill"): Promise<void> {
    const updateId = update.update_id;
    if (typeof updateId !== "number") throw new Error("update has no update_id");

    const statements: D1StatementLike[] = [
      this.db.prepare(
        "INSERT OR IGNORE INTO updates (update_id, received_at, source, raw) VALUES (?, ?, ?, ?)"
      ).bind(updateId, now(), source, JSON.stringify(update)),
    ];

    for (const field of MESSAGE_UPDATE_FIELDS) {
      const message = update[field];
      if (isMessage(message)) statements.push(...this.messageStatements(message, { updateId }));
    }

    const member = update.my_chat_member as Json | undefined;
    if (member && typeof member.chat === "object") {
      statements.push(this.chatUpsert(member.chat as Json));
      const status = (member.new_chat_member as Json | undefined)?.status;
      statements.push(
        this.db.prepare("UPDATE chats SET bot_status = ? WHERE chat_id = ?")
          .bind(typeof status === "string" ? status : null, (member.chat as Json).id)
      );
    }

    await this.db.batch(statements); // one transaction
  }

  private chatUpsert(chat: Json): D1StatementLike {
    const c = chatRow(chat);
    return this.db.prepare(
      `INSERT INTO chats (chat_id, type, title, username, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET
         type = excluded.type, title = excluded.title, username = excluded.username,
         updated_at = excluded.updated_at`
    ).bind(c.chat_id, c.type, c.title, c.username, now());
  }

  /**
   * Insert a message as the next version of (chat, message_id): 0 if new, else an edit.
   * Older versions are marked superseded so reads show the latest by default.
   */
  private messageStatements(message: Json, p: Provenance): D1StatementLike[] {
    const r = messageRow(message);
    const statements = [
      this.chatUpsert(message.chat as Json),
      this.db.prepare(
        `INSERT OR IGNORE INTO messages (
           chat_id, message_id, version, date, edit_date, from_id, from_name, from_username,
           is_bot, outgoing, client, thread_id, reply_to_message_id, kind, text, media,
           update_id, recorded_at, raw)
         SELECT ?1, ?2, COALESCE((SELECT MAX(version) + 1 FROM messages WHERE chat_id = ?1 AND message_id = ?2), 0),
           ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18`
      ).bind(
        r.chat_id, r.message_id, r.date, r.edit_date, r.from_id, r.from_name, r.from_username,
        r.is_bot ? 1 : 0, p.outgoing ? 1 : 0, p.client ?? null, r.thread_id, r.reply_to_message_id,
        r.kind, r.text, r.media.length > 0 ? JSON.stringify(r.media) : null,
        p.updateId ?? null, now(), JSON.stringify(message),
      ),
      this.db.prepare(
        `UPDATE messages SET superseded = 1 WHERE chat_id = ?1 AND message_id = ?2
           AND version < (SELECT MAX(version) FROM messages WHERE chat_id = ?1 AND message_id = ?2)`
      ).bind(r.chat_id, r.message_id),
    ];

    // A basic group upgraded to a supergroup gets a new id; link them so history follows.
    const migrateTo = message.migrate_to_chat_id;
    const migrateFrom = message.migrate_from_chat_id;
    if (typeof migrateTo === "number") {
      statements.push(this.db.prepare("UPDATE chats SET migrated_to = ? WHERE chat_id = ?").bind(migrateTo, r.chat_id));
    }
    if (typeof migrateFrom === "number") {
      statements.push(
        this.db.prepare(
          `INSERT INTO chats (chat_id, migrated_to, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (chat_id) DO UPDATE SET migrated_to = excluded.migrated_to`
        ).bind(migrateFrom, r.chat_id, now())
      );
    }
    return statements;
  }
}
