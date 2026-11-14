/** Turn a Telegram Message into the columns reads need. Everything else stays in `raw`. */

type Json = Record<string, unknown>;

export interface MediaRef {
  kind: string;
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface MessageRow {
  chat_id: number;
  message_id: number;
  date: number;
  edit_date: number | null;
  from_id: number | null;
  from_name: string | null;
  from_username: string | null;
  is_bot: boolean;
  thread_id: number | null;
  reply_to_message_id: number | null;
  kind: string;
  text: string | null;
  media: MediaRef[];
}

export interface ChatRow {
  chat_id: number;
  type: string | null;
  title: string | null;
  username: string | null;
}

/** Content keys in priority order; the first present one is the message's kind. */
const KINDS = [
  "text", "photo", "video", "animation", "document", "audio", "voice", "video_note", "sticker",
  "poll", "location", "venue", "contact", "dice", "checklist", "story", "paid_media",
  "new_chat_members", "left_chat_member", "new_chat_title", "new_chat_photo", "delete_chat_photo",
  "pinned_message", "migrate_to_chat_id", "migrate_from_chat_id", "group_chat_created",
  "supergroup_chat_created", "forum_topic_created",
] as const;

const FILE_KINDS = ["video", "animation", "document", "audio", "voice", "video_note", "sticker"] as const;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export function isMessage(value: unknown): value is Json {
  const m = value as Json | null;
  return typeof m === "object" && m !== null && typeof m.message_id === "number"
    && typeof m.date === "number" && typeof m.chat === "object" && m.chat !== null;
}

export function personName(user: Json | undefined): string | null {
  if (!user) return null;
  const name = [str(user.first_name), str(user.last_name)].filter(Boolean).join(" ");
  return name || str(user.title) || str(user.username);
}

export function chatRow(chat: Json): ChatRow {
  return {
    chat_id: chat.id as number,
    type: str(chat.type),
    title: str(chat.title) ?? personName(chat),
    username: str(chat.username),
  };
}

function fileRef(kind: string, f: Json): MediaRef {
  const ref: MediaRef = { kind, file_id: f.file_id as string };
  if (typeof f.file_unique_id === "string") ref.file_unique_id = f.file_unique_id;
  if (typeof f.file_name === "string") ref.file_name = f.file_name;
  if (typeof f.mime_type === "string") ref.mime_type = f.mime_type;
  if (typeof f.file_size === "number") ref.file_size = f.file_size;
  return ref;
}

function mediaOf(m: Json): MediaRef[] {
  const refs: MediaRef[] = [];
  if (Array.isArray(m.photo) && m.photo.length > 0) {
    refs.push(fileRef("photo", m.photo[m.photo.length - 1] as Json)); // largest size
  }
  for (const kind of FILE_KINDS) {
    const f = m[kind] as Json | undefined;
    if (f && typeof f.file_id === "string") refs.push(fileRef(kind, f));
  }
  return refs;
}

/** Text a reader should see: the text or caption, else a short rendering of non-text content. */
function textOf(m: Json, kind: string): string | null {
  const own = str(m.text) ?? str(m.caption);
  if (own !== null) return own;
  const o = (k: string) => m[k] as Json;
  switch (kind) {
    case "sticker": return str(o("sticker").emoji);
    case "poll": return `poll: ${str(o("poll").question) ?? ""}`;
    case "location": return `location: ${o("location").latitude},${o("location").longitude}`;
    case "venue": return `venue: ${str(o("venue").title) ?? ""}, ${str(o("venue").address) ?? ""}`;
    case "contact": return `contact: ${personName(o("contact")) ?? ""} ${str(o("contact").phone_number) ?? ""}`.trim();
    case "dice": return `dice ${str(o("dice").emoji) ?? ""} = ${o("dice").value}`;
    case "new_chat_members":
      return `joined: ${(m.new_chat_members as Json[]).map((u) => personName(u)).join(", ")}`;
    case "left_chat_member": return `left: ${personName(o("left_chat_member"))}`;
    case "new_chat_title": return `renamed the chat to ${str(m.new_chat_title)}`;
    case "pinned_message": return `pinned message ${o("pinned_message").message_id}`;
    case "migrate_to_chat_id": return `group upgraded to supergroup ${m.migrate_to_chat_id}`;
    case "migrate_from_chat_id": return `supergroup created from group ${m.migrate_from_chat_id}`;
    default: return null;
  }
}

export function messageRow(m: Json): MessageRow {
  const from = m.from as Json | undefined;
  const senderChat = m.sender_chat as Json | undefined; // channel posts, anonymous admins
  const reply = m.reply_to_message as Json | undefined;
  const kind = KINDS.find((k) => m[k] !== undefined) ?? "other";

  return {
    chat_id: (m.chat as Json).id as number,
    message_id: m.message_id as number,
    date: m.date as number,
    edit_date: num(m.edit_date),
    from_id: num(senderChat?.id) ?? num(from?.id),
    from_name: personName(senderChat) ?? personName(from),
    from_username: str(senderChat?.username) ?? str(from?.username),
    is_bot: from?.is_bot === true,
    thread_id: m.is_topic_message ? num(m.message_thread_id) : null,
    reply_to_message_id: num(reply?.message_id),
    kind,
    text: textOf(m, kind),
    media: mediaOf(m),
  };
}
