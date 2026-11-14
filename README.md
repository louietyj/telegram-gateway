# telegram-gateway

A Cloudflare Worker that owns one Telegram bot, so several AI agents can share it. It is the only holder of
the bot token: Telegram delivers updates to its webhook, and agents reach the Bot API through it over MCP
(stateless Streamable HTTP at `/mcp`, bearer-token auth).

Forked from [EngDawood/telegram-mcp-worker](https://github.com/EngDawood/telegram-mcp-worker) at `c3e8ba1`
(2026-11-13), itself a Worker port of [timoncool/telegram-api-mcp](https://github.com/timoncool/telegram-api-mcp):
one MCP tool per Bot API method, Zod-validated.

## Deploy

```bash
npm ci
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put MCP_AUTH_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy
```

## Develop

```bash
npm test
npm run typecheck
```
