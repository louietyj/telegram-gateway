/**
 * Cloudflare Worker entry point.
 *
 *   POST /webhook  Telegram updates; requires the setWebhook secret_token header.
 *   POST /mcp      MCP over stateless Streamable HTTP; requires MCP_AUTH_TOKEN.
 *
 * Secrets: TELEGRAM_BOT_TOKEN, MCP_AUTH_TOKEN, WEBHOOK_SECRET. All are required:
 * a missing one fails closed. Optional vars: TELEGRAM_DEFAULT_CHAT_ID,
 * TELEGRAM_DEFAULT_THREAD_ID and the tuning knobs in src/core/config.ts.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig } from "./core/config.js";
import { hasToken, safeEqual } from "./core/auth.js";
import { buildServer } from "./mcp/server.js";

export interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  MCP_AUTH_TOKEN?: string;
  WEBHOOK_SECRET?: string;
  [key: string]: string | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const misconfigured = (what: string) => json({ error: "server_misconfigured", message: `${what} is not set` }, 500);

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!env.WEBHOOK_SECRET) return misconfigured("WEBHOOK_SECRET");
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (secret === null || !(await safeEqual(secret, env.WEBHOOK_SECRET))) {
    return json({ error: "unauthorized" }, 401);
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  // eslint-disable-next-line no-console
  console.log("telegram_update", JSON.stringify(update));
  return json({ ok: true });
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (!env.MCP_AUTH_TOKEN) return misconfigured("MCP_AUTH_TOKEN");
  if (!(await hasToken(request, env.MCP_AUTH_TOKEN))) return json({ error: "unauthorized" }, 401);

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    return json({ error: "server_misconfigured", message: (error as Error).message }, 500);
  }

  const { server, client } = buildServer(config);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    client.destroy();
    await server.close().catch(() => undefined);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    switch (new URL(request.url).pathname) {
      case "/":
      case "/health":
        return new Response("ok\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
      case "/webhook":
        return handleWebhook(request, env);
      case "/mcp":
        return handleMcp(request, env);
      default:
        return json({ error: "not_found" }, 404);
    }
  },
};
