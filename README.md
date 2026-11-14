# telegram-gateway

A Cloudflare Worker that owns one Telegram bot, so several AI agents can share it. It is the only holder of
the bot token. Telegram delivers every update to its webhook, which stores it in D1. Agents use the Bot API
through it over MCP (stateless Streamable HTTP), and everything the bot sends through it is stored too. The
Bot API itself has no history, so this store is the only record of the chats.

Forked from [EngDawood/telegram-mcp-worker](https://github.com/EngDawood/telegram-mcp-worker) at `c3e8ba1`
(2026-11-13), itself a Worker port of [timoncool/telegram-api-mcp](https://github.com/timoncool/telegram-api-mcp):
one MCP tool per Bot API method, Zod-validated.

## Endpoints

| Path | Auth | |
|---|---|---|
| `POST /mcp` | `Authorization: Bearer $MCP_AUTH_TOKEN` | MCP. Optional `X-Client-Name` is recorded on what that client sends. |
| `POST /webhook` | Telegram's secret-token header | Update ingest |
| `GET/POST/DELETE /admin/webhook` | `Authorization: Bearer $ADMIN_TOKEN` | Show, set or remove the webhook |

## Tools

- Every Bot API method, except `get_updates`, `set_webhook`, `delete_webhook`, `log_out`, `close` and
  `leave_chat`, which would break the Worker's ownership of the update flow.
- File fields take a file_id, an http(s) URL, or `data:<mime>;name=<filename>;base64,<bytes>`.
- `history_chats`, `history_messages` (latest N, or everything after a `seq` cursor), `history_message`,
  `history_replies`, `history_search` (FTS5).
- `download_file`: a file's bytes as MCP image/resource content.

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
