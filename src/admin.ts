import { TelegramClient } from "./telegram/telegram-client.js";

/**
 * Updates the webhook subscribes to. message_reaction and chat_member are left out: both
 * need the bot to be a chat admin, and it isn't anywhere.
 */
export const ALLOWED_UPDATES = [
  "message", "edited_message", "channel_post", "edited_channel_post", "my_chat_member", "callback_query",
];

/**
 * /admin/webhook — GET shows getWebhookInfo; POST points the bot's webhook at this Worker;
 * DELETE removes it (to fall back to getUpdates). Pending updates are kept, so setting the
 * webhook delivers Telegram's backlog (up to 24 h) straight into D1.
 */
export async function handleAdminWebhook(
  request: Request,
  client: TelegramClient,
  webhookSecret: string
): Promise<unknown> {
  switch (request.method) {
    case "GET":
      return client.call("getWebhookInfo");
    case "POST":
      return client.call("setWebhook", {
        url: new URL("/webhook", request.url).toString(),
        secret_token: webhookSecret,
        allowed_updates: ALLOWED_UPDATES,
        drop_pending_updates: false,
      });
    case "DELETE":
      return client.call("deleteWebhook", { drop_pending_updates: false });
    default:
      throw new Error(`method ${request.method} not allowed`);
  }
}
