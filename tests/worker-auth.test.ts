import { describe, it, expect } from "vitest";
import worker, { type Env } from "../src/worker.js";
import { testDb } from "./helpers/d1.js";

// No TELEGRAM_BOT_TOKEN: a request that passes the auth gate fails later with 500.
const env: Env = { DB: testDb(), MCP_AUTH_TOKEN: "test-secret", WEBHOOK_SECRET: "hook-secret" };
const noSecrets: Env = { DB: env.DB };

function mcpRequest(headers: Record<string, string> = {}, query = ""): Request {
  return new Request(`https://worker.test/mcp${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
}

function webhookRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://worker.test/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ update_id: 1 }),
  });
}

describe("Worker /mcp auth", () => {
  it("rejects a request with no credentials", async () => {
    expect((await worker.fetch(mcpRequest(), env)).status).toBe(401);
  });

  it("accepts Authorization: Bearer <token>", async () => {
    const res = await worker.fetch(mcpRequest({ authorization: "Bearer test-secret" }), env);
    expect(res.status).not.toBe(401);
  });

  it("accepts x-api-key: <token>", async () => {
    const res = await worker.fetch(mcpRequest({ "x-api-key": "test-secret" }), env);
    expect(res.status).not.toBe(401);
  });

  it("rejects wrong tokens", async () => {
    for (const headers of [{ authorization: "Bearer wrong" }, { "x-api-key": "wrong" }, { "x-api-key": "test-secre" }]) {
      expect((await worker.fetch(mcpRequest(headers), env)).status).toBe(401);
    }
  });

  it("does not accept the token in the URL", async () => {
    expect((await worker.fetch(mcpRequest({}, "?token=test-secret"), env)).status).toBe(401);
  });

  it("fails closed when MCP_AUTH_TOKEN is unset", async () => {
    const res = await worker.fetch(mcpRequest({ authorization: "Bearer " }), noSecrets);
    expect(res.status).toBe(500);
  });
});

describe("Worker /webhook auth", () => {
  it("rejects a missing or wrong secret", async () => {
    expect((await worker.fetch(webhookRequest(), env)).status).toBe(401);
    const wrong = webhookRequest({ "x-telegram-bot-api-secret-token": "nope" });
    expect((await worker.fetch(wrong, env)).status).toBe(401);
  });

  it("accepts the right secret", async () => {
    const ok = webhookRequest({ "x-telegram-bot-api-secret-token": "hook-secret" });
    expect((await worker.fetch(ok, env)).status).toBe(200);
  });

  it("fails closed when WEBHOOK_SECRET is unset", async () => {
    const res = await worker.fetch(webhookRequest({ "x-telegram-bot-api-secret-token": "" }), noSecrets);
    expect(res.status).toBe(500);
  });
});
