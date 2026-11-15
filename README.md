# telegram-gateway

A Cloudflare Worker that owns one Telegram bot, so several AI agents can share it. It is the only holder of
the bot token. Telegram delivers every update to its webhook, which stores it in D1. Agents use the Bot API
through it over MCP (stateless Streamable HTTP), and everything the bot sends through it is stored too. The
Bot API itself has no history, so this store is the only record of the chats.

The Bot API tools come from [grammy-mcp](https://github.com/louietyj/grammyjs-mcp), which generates one tool per
method of grammY's `Api`; calls go through grammY with auto-retry. (The repo started as a fork of
[EngDawood/telegram-mcp-worker](https://github.com/EngDawood/telegram-mcp-worker) at `c3e8ba1`, whose
hand-written tool registry this replaced.)

## Endpoints

| Path | Auth | |
|---|---|---|
| `POST /mcp` | `Authorization: Bearer $MCP_AUTH_TOKEN` | MCP. Optional `X-Client-Name` is recorded on what that client sends. |
| `POST /webhook` | Telegram's secret-token header | Update ingest |
| `GET/POST/DELETE /admin/webhook` | `Authorization: Bearer $ADMIN_TOKEN` | Show, set or remove the webhook |

## Tools

- Every grammY `Api` method, except `getUpdates`, `setWebhook`, `deleteWebhook`, `logOut`, `close` and
  `leaveChat`, which would break the Worker's ownership of the update flow. Nested types are collapsed to
  their name; `describeType` expands them, and `telegramFormat` explains rich messages, albums and keyboards.
  Tools are named exactly like grammY's methods (`sendMessage`, `editMessageTextInline`).
- `chat_id` defaults to `TELEGRAM_DEFAULT_CHAT_ID` when omitted.
- File fields take a file_id, an http(s) URL (fetched and uploaded by the Worker), or
  `data:<mime>;name=<filename>;base64,<bytes>`.
- `historyChats`, `historyMessages` (latest N, or everything after a `seq` cursor), `historyMessage`,
  `historyReplies`, `historySearch` (FTS5).
- `downloadFile`: a file's bytes as MCP image/resource content.

## Deploy

```bash
npm ci
npx wrangler d1 migrations apply telegram-gateway --remote
npx wrangler secret put TELEGRAM_BOT_TOKEN   # and MCP_AUTH_TOKEN, WEBHOOK_SECRET, ADMIN_TOKEN
npx wrangler deploy
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker>/admin/webhook
```

Setting the webhook keeps Telegram's pending updates, so up to 24 h of backlog is delivered into D1.

## Develop

```bash
npm test             # unit tests; D1 is node:sqlite with the real migrations
npm run typecheck
npx wrangler dev     # local Workers runtime; secrets from .dev.vars
```
