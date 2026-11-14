import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Store } from "../src/store/store.js";
import { testDb } from "./helpers/d1.js";
import { BOT, GROUP, LOUIE, message, update } from "./helpers/fixtures.js";
import { connect, stubTelegram } from "./helpers/mcp.js";

const MUM = { id: 111, is_bot: false, first_name: "Mum" };
const T0 = 1_763_150_000;

describe("history tools", () => {
  let db: ReturnType<typeof testDb>;
  let store: Store;
  let call: Awaited<ReturnType<typeof connect>>["call"];

  const ingest = (field: string, m: Record<string, unknown>) => store.ingestUpdate(update(field, m), "webhook");

  beforeEach(async () => {
    db = testDb();
    store = new Store(db);
    ({ call } = await connect(db, "duet"));

    await ingest("message", message({ message_id: 1, date: T0, text: "What time is the aurora tour?", from: MUM }));
    await ingest("message", message({ message_id: 2, date: T0 + 60, text: "Pickup at 9pm", reply_to_message: { message_id: 1 } }));
    await ingest("message", message({
      message_id: 3, date: T0 + 120, from: MUM, text: undefined, caption: "Moose outside!",
      photo: [{ file_id: "PHOTO-ID", file_unique_id: "u", file_size: 2048 }], reply_to_message: { message_id: 2 },
    }));
    await ingest("edited_message", message({ message_id: 2, date: T0 + 60, edit_date: T0 + 90, text: "Pickup at 9:30pm", reply_to_message: { message_id: 1 } }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists chats", async () => {
    const res = await call("history_chats");
    expect(res.text).toBe(`${GROUP.id} · group · "Alaska TEST" · 3 messages · last 2025-11-14 19:55Z`);
  });

  it("shows the latest messages oldest first, current versions only", async () => {
    const res = await call("history_messages", { chat_id: GROUP.id });
    const lines = res.text.split("\n");
    expect(lines[0]).toBe("[seq 1] 2025-11-14 19:53Z #1 Mum (111): What time is the aurora tour?");
    // An edit keeps the message's original place in the chat.
    expect(lines[1]).toBe("[seq 4] 2025-11-14 19:54Z #2 ↩#1 Louie Tan @louietyj (40506052): Pickup at 9:30pm (edited 2025-11-14 19:54Z)");
    expect(lines[2]).toBe("[seq 3] 2025-11-14 19:55Z #3 ↩#2 Mum (111): Moose outside! [photo file_id=PHOTO-ID 2KB]");
    expect(res.text).toContain("(latest seq=4;");
    expect(res.text).not.toContain("Pickup at 9pm");
  });

  it("follows a cursor, including the bot's own sends", async () => {
    stubTelegram((_m, p) => message({ message_id: 4, date: T0 + 200, from: BOT, text: p.text }));
    await call("send_message", { chat_id: GROUP.id, text: "Noted, reminder set." });

    const res = await call("history_messages", { after_seq: 4 });
    expect(res.text).toContain("#4 Louie's Claude @louietyj_claude_bot (9010651977) [bot, sent via gateway by duet]: Noted, reminder set.");
    expect(res.text).toContain("(caught up; next after_seq=5)");

    const again = await call("history_messages", { after_seq: 5 });
    expect(again.text).toBe("No messages.\n\n(caught up; next after_seq=5)");
  });

  it("pages by limit and before_message_id", async () => {
    const res = await call("history_messages", { chat_id: GROUP.id, limit: 1, before_message_id: 3 });
    expect(res.text.split("\n")[0]).toContain("#2 ");
  });

  it("filters by time", async () => {
    const res = await call("history_messages", { chat_id: GROUP.id, since: new Date((T0 + 100) * 1000).toISOString() });
    expect(res.text.split("\n")[0]).toContain("#3 ");
  });

  it("shows one message with its reply chain, edits and replies", async () => {
    const res = await call("history_message", { chat_id: GROUP.id, message_id: 2 });
    expect(res.text).toMatch(/In reply to:\n\[seq 1\].*aurora tour/);
    expect(res.text).toMatch(/Message:\n\[seq 4\].*9:30pm/);
    expect(res.text).toMatch(/Earlier versions:\n\[seq 2\].*Pickup at 9pm/);
    expect(res.text).toMatch(/Replies:\n\[seq 3\].*Moose/);
  });

  it("notes a replied-to message that was never stored", async () => {
    await ingest("message", message({ message_id: 10, text: "yes", reply_to_message: { message_id: 9 } }));
    const res = await call("history_message", { chat_id: GROUP.id, message_id: 10 });
    expect(res.text).toContain("In reply to:\n#9 (not stored)");
  });

  it("lists replies", async () => {
    const res = await call("history_replies", { chat_id: String(GROUP.id), message_id: 1 });
    expect(res.text).toContain("9:30pm");
  });

  it("searches text, captions and names; falls back to plain words on bad syntax", async () => {
    expect((await call("history_search", { query: "moose" })).text).toContain("chat -5595413740 #3");
    expect((await call("history_search", { query: "aur*" })).text).toContain("#1 ");
    expect((await call("history_search", { query: "pickup 9:30pm?" })).text).toContain("#2 ");
    expect((await call("history_search", { query: "Mum", chat_id: GROUP.id })).text.split("\n")).toHaveLength(2);
    expect((await call("history_search", { query: "zebra" })).text).toBe("No matches.");
  });

  it("follows a chat across a group-to-supergroup upgrade", async () => {
    const supergroup = { id: -1005595413740, type: "supergroup", title: "Alaska TEST" };
    await ingest("message", message({ message_id: 20, text: undefined, migrate_to_chat_id: supergroup.id }));
    await ingest("message", message({ message_id: 1, chat: supergroup, text: undefined, migrate_from_chat_id: GROUP.id }));
    await ingest("message", message({ message_id: 2, chat: supergroup, text: "after upgrade", from: LOUIE }));

    const res = await call("history_messages", { chat_id: supergroup.id });
    expect(res.text).toContain("aurora tour");
    expect(res.text).toContain("after upgrade");
  });

  it("resolves @usernames and reports unknown ones", async () => {
    await ingest("channel_post", message({ chat: { id: -1009, type: "channel", title: "News", username: "news" }, from: undefined, text: "x" }));
    expect((await call("history_messages", { chat_id: "@News" })).text).toContain("News @news (-1009)");
    const res = await call("history_messages", { chat_id: "@nobody" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/No known chat/);
  });
});
