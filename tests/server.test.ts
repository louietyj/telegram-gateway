import { describe, it, expect } from "vitest";
import { BLOCKED_TOOLS } from "../src/mcp/server.js";
import { testDb } from "./helpers/d1.js";
import { BOT, GROUP, message } from "./helpers/fixtures.js";
import { connect, DEFAULT_CHAT, stubTelegram } from "./helpers/mcp.js";

describe("tool list", () => {
  it("has the generated Bot API tools and the gateway's own, minus the blocked ones", async () => {
    const { client } = await connect(testDb());
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const name of ["sendMessage", "editMessageTextInline", "describeType", "historyMessages", "downloadFile", "telegramFormat"]) {
      expect(names.has(name), name).toBe(true);
    }
    for (const name of BLOCKED_TOOLS) expect(names.has(name), name).toBe(false);
  });

  it("refuses blocked tools without calling Telegram", async () => {
    const calls = stubTelegram(() => true);
    const { call } = await connect(testDb());
    const res = await call("setWebhook", { url: "https://evil.example" });
    expect(res.isError).toBe(true);
    expect(calls).not.toHaveBeenCalled();
  });

  it("makes chat_id optional and fills in the default chat", async () => {
    const calls = stubTelegram((_m, p) => message({ chat: { id: Number(p.chat_id), type: "private" }, from: BOT, text: p.text }));
    const { client, call } = await connect(testDb());
    const send = (await client.listTools()).tools.find((t) => t.name === "sendMessage")!;
    expect(send.inputSchema.required).toEqual(["text"]);

    await call("sendMessage", { text: "hi" });
    await call("sendMessage", { chat_id: GROUP.id, text: "hi group" });
    expect(calls.mock.calls.map(([, p]) => p.chat_id)).toEqual([DEFAULT_CHAT, GROUP.id]);
  });

  it("fetches URLs in file fields instead of handing them to Telegram", async () => {
    const calls = stubTelegram(() => message({ from: BOT }));
    const { call } = await connect(testDb());
    await call("sendPhoto", { chat_id: GROUP.id, photo: "https://example.com/moose.jpg" });
    expect(calls.mock.calls[0][1].photo).not.toBe("https://example.com/moose.jpg");
  });
});
