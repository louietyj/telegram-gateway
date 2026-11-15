import { describe, it, expect, afterEach, vi } from "vitest";
import worker, { type Env } from "../src/worker.js";
import { testDb } from "./helpers/d1.js";
import { stubTelegram } from "./helpers/mcp.js";

const env: Env = {
  DB: testDb(), TELEGRAM_BOT_TOKEN: "123:t", MCP_AUTH_TOKEN: "m", WEBHOOK_SECRET: "hook", ADMIN_TOKEN: "admin",
};
const admin = (method: string, token = "admin") =>
  new Request("https://gw.example.workers.dev/admin/webhook", { method, headers: { authorization: `Bearer ${token}` } });

describe("/admin/webhook", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects the MCP token and a missing token", async () => {
    stubTelegram(() => true);
    expect((await worker.fetch(admin("POST", "m"), env)).status).toBe(401);
    expect((await worker.fetch(new Request("https://gw.example.workers.dev/admin/webhook", { method: "POST" }), env)).status).toBe(401);
  });

  it("points the webhook at this Worker with the secret, keeping the backlog", async () => {
    const calls = stubTelegram(() => true);

    const res = await worker.fetch(admin("POST"), env);

    expect(res.status).toBe(200);
    const [method, payload] = calls.mock.calls[0];
    expect(method).toBe("setWebhook");
    expect(payload).toEqual({
      url: "https://gw.example.workers.dev/webhook",
      secret_token: "hook",
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "my_chat_member", "callback_query"],
      drop_pending_updates: false,
    });
  });

  it("shows and deletes the webhook", async () => {
    const calls = stubTelegram((m) => (m === "getWebhookInfo" ? { url: "x", pending_update_count: 3 } : true));

    const info = await worker.fetch(admin("GET"), env);
    expect(await info.json()).toEqual({ ok: true, result: { url: "x", pending_update_count: 3 } });

    await worker.fetch(admin("DELETE"), env);
    expect(calls.mock.calls[1][0]).toBe("deleteWebhook");
  });
});
