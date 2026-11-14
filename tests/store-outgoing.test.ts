import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { testDb } from "./helpers/d1.js";
import { BOT, GROUP, message } from "./helpers/fixtures.js";
import { connect, stubTelegram } from "./helpers/mcp.js";

type Row = Record<string, unknown>;

describe("recording what the bot sends", () => {
  let db: ReturnType<typeof testDb>;
  const rows = (sql: string) => db.sqlite.prepare(sql).all() as Row[];

  beforeEach(() => {
    db = testDb();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records a sent message as outgoing, with the client's name", async () => {
    stubTelegram((_m, p) => message({ message_id: 50, from: BOT, text: p.text }));
    const { call } = await connect(db, "duet");

    const res = await call("send_message", { chat_id: GROUP.id, text: "Morning! Today: aurora tour." });

    expect(res.isError).toBeFalsy();
    expect(rows("SELECT message_id, outgoing, client, is_bot, text FROM messages")).toEqual([
      { message_id: 50, outgoing: 1, client: "duet", is_bot: 1, text: "Morning! Today: aurora tour." },
    ]);
  });

  it("records an edit as a new version", async () => {
    stubTelegram((_m, p) => message({ message_id: 50, from: BOT, text: p.text, edit_date: p.text === "v2" ? 2 : undefined }));
    const { call } = await connect(db);

    await call("send_message", { chat_id: GROUP.id, text: "v1" });
    await call("edit_message_text", { chat_id: GROUP.id, message_id: 50, text: "v2" });

    expect(rows("SELECT version, superseded, text FROM messages ORDER BY id")).toEqual([
      { version: 0, superseded: 1, text: "v1" },
      { version: 1, superseded: 0, text: "v2" },
    ]);
  });

  it("records every message of a media group", async () => {
    stubTelegram(() => [
      message({ message_id: 60, from: BOT, text: undefined, photo: [{ file_id: "a", file_unique_id: "a" }] }),
      message({ message_id: 61, from: BOT, text: undefined, photo: [{ file_id: "b", file_unique_id: "b" }] }),
    ]);
    const { call } = await connect(db);

    await call("send_media_group", { chat_id: GROUP.id, media: [{ type: "photo", media: "x" }, { type: "photo", media: "y" }] });

    expect(rows("SELECT message_id FROM messages ORDER BY id")).toEqual([{ message_id: 60 }, { message_id: 61 }]);
  });

  it("marks deleted messages, defaulting chat_id like the Bot API call does", async () => {
    stubTelegram((_m, p) => (p.text ? message({ chat: { id: 40506052, type: "private" }, message_id: 7, from: BOT, text: p.text }) : true));
    const { call } = await connect(db);

    await call("send_message", { text: "oops" });
    await call("delete_message", { message_id: 7 });

    expect(rows("SELECT deleted_at IS NOT NULL AS deleted FROM messages")).toEqual([{ deleted: 1 }]);
  });

  it("reports a recording failure without hiding that the send succeeded", async () => {
    stubTelegram(() => message({ message_id: 70, from: BOT }));
    const { call } = await connect(db);
    db.sqlite.exec("DROP TABLE messages_fts");

    const res = await call("send_message", { chat_id: GROUP.id, text: "hi" });

    expect(res.isError).toBeFalsy();
    expect(res.text).toMatch(/Warning: sent, but not recorded/);
  });
});
