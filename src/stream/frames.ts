import { MESSAGE_UPDATE_FIELDS } from "../store/store.js";

type Json = Record<string, any>;

export interface EventRow {
  seq: number;
  recorded_at: number;
  source: "telegram" | "gateway";
  client: string | null;
  payload: string;
}

export interface BotIdentity {
  id: number;
  username: string | null;
}

/** What the gateway adds to a Telegram update; labels for the client's filters, never filters. */
export interface GatewayMeta {
  is_mention?: boolean;
  reply_to_from_bot?: boolean;
}

function updateMessage(update: Json): Json | undefined {
  for (const field of MESSAGE_UPDATE_FIELDS) {
    if (update[field] && typeof update[field] === "object") return update[field];
  }
  return undefined;
}

/** Whether the message tags the bot: an @username mention or a text_mention of its user. */
function mentionsBot(message: Json, bot: BotIdentity): boolean {
  const text: string = message.text ?? message.caption ?? "";
  const entities: Json[] = message.entities ?? message.caption_entities ?? [];
  const handle = bot.username ? `@${bot.username}`.toLowerCase() : null;
  return entities.some((e) =>
    (e.type === "text_mention" && e.user?.id === bot.id) ||
    (e.type === "mention" && handle !== null &&
      text.substring(e.offset, e.offset + e.length).toLowerCase() === handle));
}

export function gatewayMeta(update: Json, bot: BotIdentity): GatewayMeta {
  const message = updateMessage(update);
  if (!message) return {};
  return {
    is_mention: mentionsBot(message, bot),
    reply_to_from_bot: message.reply_to_message?.from?.id === bot.id,
  };
}

/** One stream frame. The stored payload is spliced in as-is, so Telegram's update arrives verbatim. */
export function eventFrame(row: EventRow, bot: BotIdentity): string {
  const head = `{"type":"event","seq":${row.seq},"time":${row.recorded_at},"source":"${row.source}"`;
  if (row.source === "telegram") {
    const meta = gatewayMeta(JSON.parse(row.payload), bot);
    return `${head},"update":${row.payload},"_gateway_meta":${JSON.stringify(meta)}}`;
  }
  return `${head},"client":${JSON.stringify(row.client)},"call":${row.payload}}`;
}

/** First frame on a socket: replay covers seqs after `afterSeq` up to `latestSeq`, then it's live. */
export function helloFrame(afterSeq: number, latestSeq: number): string {
  return JSON.stringify({ type: "hello", after_seq: afterSeq, latest_seq: latestSeq });
}
