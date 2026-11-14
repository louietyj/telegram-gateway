import { vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/mcp/server.js";
import { Store } from "../../src/store/store.js";
import type { Config } from "../../src/core/config.js";
import type { D1Like } from "../../src/store/db.js";

export const testConfig: Config = {
  botToken: "123:test-token",
  defaultChatId: "40506052",
  globalRateLimit: 100,
  perChatRateLimit: 100,
  maxRetries: 1,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldown: 30000,
  maxFileSize: 50 * 1024 * 1024,
};

/** Stub Telegram: `respond(method, params)` returns the Bot API `result`. */
export function stubTelegram(respond: (method: string, params: Record<string, unknown>) => unknown) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const params = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    return new Response(JSON.stringify({ ok: true, result: respond(method, params) }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export async function connect(db: D1Like, clientName: string | null = "test") {
  const { server } = buildServer(testConfig, new Store(db), clientName);
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
