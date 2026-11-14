import { MediaRef } from "./normalize.js";
import { StoredChat, StoredMessage } from "./read.js";

/** 2026-11-14 22:05Z */
export function time(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function sender(m: StoredMessage): string {
  const name = m.from_name ?? "unknown";
  const handle = m.from_username ? ` @${m.from_username}` : "";
  const id = m.from_id !== null ? ` (${m.from_id})` : "";
  const tags = [m.is_bot ? "bot" : null, m.outgoing ? `sent via gateway${m.client ? ` by ${m.client}` : ""}` : null]
    .filter(Boolean);
  return `${name}${handle}${id}${tags.length ? ` [${tags.join(", ")}]` : ""}`;
}

function mediaText(media: string | null): string {
  if (!media) return "";
  return (JSON.parse(media) as MediaRef[]).map((f) => {
    const parts = [f.kind, `file_id=${f.file_id}`];
    if (f.file_name) parts.push(`name=${f.file_name}`);
    if (f.file_size) parts.push(`${Math.ceil(f.file_size / 1024)}KB`);
    return ` [${parts.join(" ")}]`;
  }).join("");
}

/**
 * One message as one line (continuation lines indented):
 * [seq 42] 2026-11-14 22:05Z chat -100… #123 ↩#120 Louie Tan @louietyj (40506052): text [photo file_id=…]
 */
export function formatMessage(m: StoredMessage, showChat: boolean): string {
  const head = [
    `[seq ${m.id}]`,
    time(m.date),
    showChat ? `chat ${m.chat_id}` : null,
    `#${m.message_id}`,
    m.reply_to_message_id !== null ? `↩#${m.reply_to_message_id}` : null,
  ].filter(Boolean).join(" ");
  const notes = [
    m.edit_date !== null ? `edited ${time(m.edit_date)}` : null,
    m.deleted_at !== null ? "deleted" : null,
  ].filter(Boolean);
  const text = (m.text ?? `(${m.kind})`).replace(/\n/g, "\n    ");
  return `${head} ${sender(m)}: ${text}${mediaText(m.media)}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

export function formatMessages(messages: StoredMessage[]): string {
  const showChat = new Set(messages.map((m) => m.chat_id)).size > 1;
  return messages.map((m) => formatMessage(m, showChat)).join("\n");
}

export function formatChat(c: StoredChat): string {
  const parts = [
    `${c.chat_id}`,
    c.type ?? "?",
    c.title ? `"${c.title}"` : null,
    c.username ? `@${c.username}` : null,
    `${c.messages} messages`,
    c.last_date !== null ? `last ${time(c.last_date)}` : null,
    c.bot_status && c.bot_status !== "member" ? `bot ${c.bot_status}` : null,
    c.migrated_to !== null ? `upgraded to ${c.migrated_to}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}
