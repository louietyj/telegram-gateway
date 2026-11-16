/**
 * Cloudflare Worker entry point.
 *
 *   POST /webhook  Telegram updates; requires the setWebhook secret_token header.
 *   POST /mcp      MCP over stateless Streamable HTTP; requires MCP_AUTH_TOKEN. An optional
 *                  X-Client-Name header is recorded on the messages that client sends.
 *   /admin/webhook GET/POST/DELETE the bot's webhook (src/admin.ts); requires ADMIN_TOKEN.
 *   GET /stream    WebSocket of the event stream (src/stream/); requires MCP_AUTH_TOKEN.
 *                  ?after_seq=N resumes after a seq, ?since=<unix> starts at a time, neither
 *                  starts now.
 *
 * Bindings: DB (D1, schema in migrations/), HUB (the StreamHub Durable Object).
 * Secrets: TELEGRAM_BOT_TOKEN, MCP_AUTH_TOKEN, WEBHOOK_SECRET, ADMIN_TOKEN. All are required:
 * a missing one fails closed. Optional var: TELEGRAM_DEFAULT_CHAT_ID, used when a tool
 * call omits chat_id.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { autoRetry } from "@grammyjs/auto-retry";
import { Api } from "grammy";
import { hasToken, safeEqual } from "./core/auth.js";
import { buildServer } from "./mcp/server.js";
import { D1Like } from "./store/db.js";
import { Store } from "./store/store.js";
import { Reader } from "./store/read.js";
import { handleAdminWebhook } from "./admin.js";
import type { DurableObjectNamespace } from "./stream/durable.js";

export { StreamHub } from "./stream/durable.js";

export interface Env {
  DB: D1Like;
  HUB?: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  MCP_AUTH_TOKEN?: string;
  WEBHOOK_SECRET?: string;
  ADMIN_TOKEN?: string;
  TELEGRAM_DEFAULT_CHAT_ID?: string;
}

/** grammY's Api, retrying rate limits and server errors. Tests swap in a stub. */
export let createApi = (token: string): Api => {
  const api = new Api(token);
  api.config.use(autoRetry({ maxDelaySeconds: 30 }));
  return api;
};
export function setApiFactory(factory: (token: string) => Api): void {
  createApi = factory;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const misconfigured = (what: string) => json({ error: "server_misconfigured", message: `${what} is not set` }, 500);

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const hub = (ns: DurableObjectNamespace) => ns.get(ns.idFromName("stream"));

/** A Store that wakes the stream hub after each write, without delaying the response. */
function store(env: Env, ctx?: Ctx): Store {
  const ns = env.HUB;
  if (!ns) return new Store(env.DB);
  return new Store(env.DB, () => {
    const poke = hub(ns).fetch(new Request("https://hub/poke", { method: "POST" }))
      .catch((error) => console.error("stream poke failed", (error as Error).message));
    ctx?.waitUntil(poke);
  });
}

async function handleStream(request: Request, env: Env): Promise<Response> {
  if (!env.MCP_AUTH_TOKEN) return misconfigured("MCP_AUTH_TOKEN");
  if (!(await hasToken(request, env.MCP_AUTH_TOKEN))) return json({ error: "unauthorized" }, 401);
  if (!env.HUB) return misconfigured("HUB");
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "upgrade_required", message: "/stream is a WebSocket" }, 426);
  }

  const query = new URL(request.url).searchParams;
  const params = new URLSearchParams();
  for (const name of ["after_seq", "since"]) {
    const value = query.get(name);
    if (value === null) continue;
    if (!/^\d+$/.test(value)) return json({ error: "bad_request", message: `${name} must be a non-negative integer` }, 400);
    params.set(name, value);
  }
  if (params.has("after_seq") && params.has("since")) {
    return json({ error: "bad_request", message: "pass after_seq or since, not both" }, 400);
  }
  return hub(env.HUB).fetch(new Request(`https://hub/connect?${params}`, request));
}

async function handleWebhook(request: Request, env: Env, ctx?: Ctx): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!env.WEBHOOK_SECRET) return misconfigured("WEBHOOK_SECRET");
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (secret === null || !(await safeEqual(secret, env.WEBHOOK_SECRET))) {
    return json({ error: "unauthorized" }, 401);
  }

  let update: Record<string, unknown>;
  try {
    update = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  // Store before acknowledging: a non-2xx makes Telegram redeliver, and ingest is idempotent.
  try {
    await store(env, ctx).ingestUpdate(update, "webhook");
  } catch (error) {
    console.error("ingest failed", update.update_id, (error as Error).message);
    return json({ error: "ingest_failed" }, 500);
  }
  return json({ ok: true });
}

async function handleMcp(request: Request, env: Env, ctx?: Ctx): Promise<Response> {
  if (!env.MCP_AUTH_TOKEN) return misconfigured("MCP_AUTH_TOKEN");
  if (!(await hasToken(request, env.MCP_AUTH_TOKEN))) return json({ error: "unauthorized" }, 401);

  if (!env.TELEGRAM_BOT_TOKEN) return misconfigured("TELEGRAM_BOT_TOKEN");

  const server = buildServer({
    api: createApi(env.TELEGRAM_BOT_TOKEN),
    token: env.TELEGRAM_BOT_TOKEN,
    store: store(env, ctx),
    reader: new Reader(env.DB),
    clientName: request.headers.get("x-client-name"),
    defaultChatId: env.TELEGRAM_DEFAULT_CHAT_ID,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => undefined);
  }
}

async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN) return misconfigured("ADMIN_TOKEN");
  if (!env.WEBHOOK_SECRET) return misconfigured("WEBHOOK_SECRET");
  if (!env.TELEGRAM_BOT_TOKEN) return misconfigured("TELEGRAM_BOT_TOKEN");
  if (!(await hasToken(request, env.ADMIN_TOKEN))) return json({ error: "unauthorized" }, 401);

  try {
    const api = createApi(env.TELEGRAM_BOT_TOKEN);
    return json({ ok: true, result: await handleAdminWebhook(request, api, env.WEBHOOK_SECRET) });
  } catch (error) {
    return json({ ok: false, error: (error as Error).message }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx?: Ctx): Promise<Response> {
    switch (new URL(request.url).pathname) {
      case "/":
      case "/health":
        return new Response("ok\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
      case "/webhook":
        return handleWebhook(request, env, ctx);
      case "/mcp":
        return handleMcp(request, env, ctx);
      case "/stream":
        return handleStream(request, env);
      case "/admin/webhook":
        return handleAdmin(request, env);
      default:
        return json({ error: "not_found" }, 404);
    }
  },
};
