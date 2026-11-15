import { vi } from "vitest";
import { Api } from "grammy";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/mcp/server.js";
import { createApi, setApiFactory } from "../../src/worker.js";
import { Store } from "../../src/store/store.js";
import { Reader } from "../../src/store/read.js";
import type { D1Like } from "../../src/store/db.js";

export const TOKEN = "123:test-token";
export const DEFAULT_CHAT = "40506052";

type Respond = (method: string, payload: Record<string, unknown>) => unknown;

let respond: Respond;
let calls = vi.fn();

// Every Api the Worker creates answers in-process instead of calling Telegram.
setApiFactory((token) => {
  const api = new Api(token);
  api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    calls(method, p);
    try {
      return { ok: true, result: respond(method, p) } as never;
    } catch (error) {
      return { ok: false, error_code: 400, description: (error as Error).message } as never;
    }
  });
  return api;
});

/**
 * Answer Bot API calls with `respond(method, payload)`; a thrown error becomes a
 * Telegram error response. Returns a mock whose calls are `[method, payload]`.
 */
export function stubTelegram(r: Respond) {
  respond = r;
  calls = vi.fn();
  return calls;
}

stubTelegram((method) => {
  throw new Error(`unstubbed Telegram call: ${method}`);
});

export async function connect(db: D1Like, clientName: string | null = "test") {
  const server = buildServer({
    api: createApi(TOKEN),
    token: TOKEN,
    store: new Store(db),
    reader: new Reader(db),
    clientName,
    defaultChatId: DEFAULT_CHAT,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string; data?: string; mimeType?: string }[];
      isError?: boolean;
    };
    return { ...res, text: res.content.map((c) => c.text ?? "").join("\n") };
  };
  return { client, call };
}
