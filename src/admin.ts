import type { Api } from "grammy";

/**
 * Updates the webhook subscribes to. message_reaction and chat_member are left out: both
 * need the bot to be a chat admin, and it isn't anywhere.
 */
export const ALLOWED_UPDATES = [
  "message", "edited_message", "channel_post", "edited_channel_post", "my_chat_member", "callback_query",
] as const;

/**
 * /admin/webhook — GET shows getWebhookInfo; POST points the bot's webhook at this Worker;
 * DELETE removes it (to fall back to getUpdates). Pending updates are kept, so setting the
 * webhook delivers Telegram's backlog (up to 24 h) straight into D1.
 */
export async function handleAdminWebhook(
  request: Request,
  api: Api,
  webhookSecret: string
): Promise<unknown> {
  switch (request.method) {
    case "GET":
      return api.getWebhookInfo();
    case "POST":
      return api.setWebhook(new URL("/webhook", request.url).toString(), {
        secret_token: webhookSecret,
        allowed_updates: ALLOWED_UPDATES,
        drop_pending_updates: false,
      });
    case "DELETE":
      return api.deleteWebhook({ drop_pending_updates: false });
    default:
      throw new Error(`method ${request.method} not allowed`);
  }
}
