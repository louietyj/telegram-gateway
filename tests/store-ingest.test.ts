import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { testDb } from "./helpers/d1.js";
import { GROUP, LOUIE, message, update } from "./helpers/fixtures.js";

type Row = Record<string, unknown>;

describe("Store.ingestUpdate", () => {
  let db: ReturnType<typeof testDb>;
  let store: Store;
  const rows = (sql: string, ...args: (string | number)[]) => db.sqlite.prepare(sql).all(...args) as Row[];

  beforeEach(() => {
    db = testDb();
    store = new Store(db);
  });

  it("stores the update and a normalized message", async () => {
    await store.ingestUpdate(update("message", message({ reply_to_message: message({ message_id: 0 }) })), "webhook");

    expect(rows("SELECT * FROM updates")).toHaveLength(1);
    const [m] = rows("SELECT * FROM messages");
    expect(m).toMatchObject({
      chat_id: GROUP.id, message_id: 1, version: 0, superseded: 0, from_id: LOUIE.id,
      from_name: "Louie Tan", from_username: "louietyj", kind: "text", text: "hello",
      reply_to_message_id: 0, outgoing: 0,
    });
    expect(rows("SELECT * FROM chats")[0]).toMatchObject({ chat_id: GROUP.id, type: "group", title: "Alaska TEST" });
  });

  it("ignores a redelivered update", async () => {
    const u = update("message", message());
    await store.ingestUpdate(u, "webhook");
    await store.ingestUpdate(u, "webhook");
    expect(rows("SELECT * FROM updates")).toHaveLength(1);
    expect(rows("SELECT * FROM messages")).toHaveLength(1);
  });

  it("stores an edit as a new version and supersedes the old one", async () => {
    await store.ingestUpdate(update("message", message()), "webhook");
    await store.ingestUpdate(update("edited_message", message({ text: "hello!", edit_date: 1_763_150_060 })), "webhook");

    const versions = rows("SELECT version, superseded, text, edit_date FROM messages ORDER BY id");
    expect(versions).toEqual([
      { version: 0, superseded: 1, text: "hello", edit_date: null },
      { version: 1, superseded: 0, text: "hello!", edit_date: 1_763_150_060 },
    ]);
  });

  it("indexes text for full-text search", async () => {
    await store.ingestUpdate(update("message", message({ text: "Aurora tour pickup at 9pm" })), "webhook");
    const hits = rows("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?", "aurora");
    expect(hits).toHaveLength(1);
  });

  it("keeps the largest photo size and the caption", async () => {
    const photo = [
      { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
      { file_id: "large", file_unique_id: "l", width: 1280, height: 960, file_size: 120_000 },
    ];
    await store.ingestUpdate(update("message", message({ text: undefined, photo, caption: "moose!" })), "webhook");

    const [m] = rows("SELECT kind, text, media FROM messages");
    expect(m.kind).toBe("photo");
    expect(m.text).toBe("moose!");
    expect(JSON.parse(m.media as string)).toEqual([
      { kind: "photo", file_id: "large", file_unique_id: "l", file_size: 120_000 },
    ]);
  });

  it("attributes channel posts to the channel", async () => {
    const channel = { id: -1001, type: "channel", title: "News", username: "news" };
    await store.ingestUpdate(update("channel_post", message({ chat: channel, from: undefined, sender_chat: channel })), "webhook");
    expect(rows("SELECT from_id, from_name FROM messages")[0]).toEqual({ from_id: -1001, from_name: "News" });
  });

  it("links a group to the supergroup it was upgraded to", async () => {
    const supergroup = { id: -1005595413740, type: "supergroup", title: "Alaska TEST" };
    await store.ingestUpdate(update("message", message({ message_id: 9, text: undefined, migrate_to_chat_id: supergroup.id })), "webhook");
    await store.ingestUpdate(update("message", message({ message_id: 1, chat: supergroup, text: undefined, migrate_from_chat_id: GROUP.id })), "webhook");

    expect(rows("SELECT chat_id, migrated_to FROM chats ORDER BY chat_id")).toEqual([
      { chat_id: supergroup.id, migrated_to: null },
      { chat_id: GROUP.id, migrated_to: supergroup.id },
    ]);
    expect(rows("SELECT text FROM messages WHERE message_id = 9")[0].text)
      .toBe(`group upgraded to supergroup ${supergroup.id}`);
  });

  it("tracks the bot's membership from my_chat_member", async () => {
    await store.ingestUpdate(update("my_chat_member", {
      chat: GROUP, from: LOUIE, date: 1, old_chat_member: { status: "left" }, new_chat_member: { status: "member" },
    }), "webhook");
    expect(rows("SELECT bot_status FROM chats")[0].bot_status).toBe("member");
  });

  it("stores updates with no message raw only", async () => {
    await store.ingestUpdate(update("callback_query", { id: "1", from: LOUIE, data: "x" }), "webhook");
    expect(rows("SELECT * FROM updates")).toHaveLength(1);
    expect(rows("SELECT * FROM messages")).toHaveLength(0);
  });
});
