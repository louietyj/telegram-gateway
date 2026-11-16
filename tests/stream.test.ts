import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker, { type Env } from "../src/worker.js";
import { Store } from "../src/store/store.js";
import { eventFrame, gatewayMeta, type BotIdentity } from "../src/stream/frames.js";
import { Hub, type StreamSocket } from "../src/stream/hub.js";
import { testDb } from "./helpers/d1.js";
import { BOT, GROUP, LOUIE, message, update } from "./helpers/fixtures.js";
import { connect, stubTelegram } from "./helpers/mcp.js";

type Row = Record<string, unknown>;
const IDENTITY: BotIdentity = { id: BOT.id, username: BOT.username };

class FakeSocket implements StreamSocket {
  frames: Row[] = [];
  closed = false;
  private attachment: unknown = null;
  send(data: string) {
    if (this.closed) throw new Error("closed");
    this.frames.push(JSON.parse(data));
  }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment; }
  events() { return this.frames.filter((f) => f.type === "event"); }
  seqs() { return this.events().map((f) => f.seq); }
}

describe("the event stream's record", () => {
  let db: ReturnType<typeof testDb>;
  const events = () => db.sqlite.prepare("SELECT source, update_id, client, payload FROM events ORDER BY seq").all() as Row[];

  beforeEach(() => { db = testDb(); });
  afterEach(() => vi.unstubAllGlobals());

  it("records each Telegram update verbatim, once, and calls onEvent", async () => {
    const onEvent = vi.fn();
    const store = new Store(db, onEvent);
    const u = update("my_chat_member", { chat: GROUP, new_chat_member: { status: "member" } });

    await store.ingestUpdate(u, "webhook");
    await store.ingestUpdate(u, "webhook");

    expect(events()).toEqual([{ source: "telegram", update_id: u.update_id, client: null, payload: JSON.stringify(u) }]);
    expect(onEvent).toHaveBeenCalled();
  });

  it("records the bot's calls with method, params and result, but not get* reads", async () => {
    stubTelegram((m, p) => (m === "getMe" ? BOT : m === "deleteMessage" ? true : message({ message_id: 50, from: BOT, text: p.text })));
    const { call } = await connect(db, "duet");

    await call("getMe");
    await call("sendMessage", { chat_id: GROUP.id, text: "hi" });
    await call("deleteMessage", { chat_id: GROUP.id, message_id: 50 });

    const rows = events();
    expect(rows.map((r) => [r.source, r.client, JSON.parse(r.payload as string).method])).toEqual([
      ["gateway", "duet", "sendMessage"],
      ["gateway", "duet", "deleteMessage"],
    ]);
    const send = JSON.parse(rows[0].payload as string);
    expect(send.params).toEqual({ chat_id: GROUP.id, text: "hi" });
    expect(send.result).toMatchObject({ message_id: 50, text: "hi" });
    expect(JSON.parse(rows[1].payload as string)).toEqual({
      method: "deleteMessage", params: { chat_id: GROUP.id, message_id: 50 }, result: true,
    });
  });

  it("reduces uploaded files in params to their names", async () => {
    stubTelegram(() => message({ message_id: 51, from: BOT, text: undefined, photo: [{ file_id: "p", file_unique_id: "p" }] }));
    const { call } = await connect(db);

    const res = await call("sendPhoto", { chat_id: GROUP.id, photo: "data:image/png;name=map.png;base64,iVBORw0KGgo=" });

    expect(res.text).not.toMatch(/not recorded/);
    expect(JSON.parse(events()[0].payload as string).params.photo).toEqual({ input_file: "map.png" });
  });

  it("backfills events from what was stored before the table existed", () => {
    const sqlite = new DatabaseSync(":memory:");
    const migrations = join(import.meta.dirname, "../migrations");
    sqlite.exec(readFileSync(join(migrations, "0001_init.sql"), "utf8"));
    const insertMessage = sqlite.prepare(
      `INSERT INTO messages (chat_id, message_id, version, date, outgoing, client, kind, recorded_at, raw, deleted_at)
       VALUES (?, ?, 0, 0, ?, ?, 'text', ?, ?, ?)`
    );
    sqlite.prepare("INSERT INTO updates (update_id, received_at, source, raw) VALUES (7, 100, 'webhook', '{\"update_id\":7}')").run();
    insertMessage.run(GROUP.id, 1, 0, null, 100, "{}", null);
    insertMessage.run(GROUP.id, 2, 1, "duet", 200, '{"message_id":2}', 300);

    sqlite.exec(readFileSync(join(migrations, "0002_events.sql"), "utf8"));

    const rows = sqlite.prepare("SELECT recorded_at, source, client, payload FROM events ORDER BY seq").all() as Row[];
    expect(rows.map((r) => [r.recorded_at, r.source, r.client, JSON.parse(r.payload as string)])).toEqual([
      [100, "telegram", null, { update_id: 7 }],
      [200, "gateway", "duet", { method: null, params: null, result: { message_id: 2 }, backfilled: true }],
      [300, "gateway", null, {
        method: "deleteMessage", params: { chat_id: GROUP.id, message_id: 2 }, result: true, backfilled: true,
      }],
    ]);
  });
});

describe("frames", () => {
  const mention = (text: string, entities: Row[]) => update("message", message({ text, entities }));

  it("flags an @mention of the bot, case-insensitively, and not of someone else", () => {
    expect(gatewayMeta(mention("hey @LouieTYJ_Claude_Bot", [{ type: "mention", offset: 4, length: 20 }]), IDENTITY).is_mention).toBe(true);
    expect(gatewayMeta(mention("hey @louietyj", [{ type: "mention", offset: 4, length: 9 }]), IDENTITY).is_mention).toBe(false);
  });

  it("flags a text_mention of the bot and a mention in a caption", () => {
    expect(gatewayMeta(mention("Claude?", [{ type: "text_mention", offset: 0, length: 6, user: BOT }]), IDENTITY).is_mention).toBe(true);
    const photo = update("message", message({ text: undefined, caption: "@louietyj_claude_bot look", caption_entities: [{ type: "mention", offset: 0, length: 20 }] }));
    expect(gatewayMeta(photo, IDENTITY).is_mention).toBe(true);
  });

  it("flags a reply to the bot, edits included", () => {
    const reply = update("edited_message", message({ reply_to_message: message({ message_id: 9, from: BOT }) }));
    expect(gatewayMeta(reply, IDENTITY)).toEqual({ is_mention: false, reply_to_from_bot: true });
  });

  it("adds no labels to updates that carry no message", () => {
    expect(gatewayMeta(update("my_chat_member", { chat: GROUP }), IDENTITY)).toEqual({});
  });

  it("splices the stored update in byte for byte", () => {
    const payload = '{"update_id":1,"message":{"text":"caf\\u00e9","chat":{"id":1}}}';
    const frame = eventFrame({ seq: 4, recorded_at: 9, source: "telegram", client: null, payload }, IDENTITY);
    expect(frame).toContain(`"update":${payload},`);
    expect(JSON.parse(frame)).toMatchObject({ type: "event", seq: 4, time: 9, source: "telegram", _gateway_meta: {} });
  });
});

describe("Hub", () => {
  let db: ReturnType<typeof testDb>;
  let store: Store;
  let sockets: FakeSocket[];
  let hub: Hub;

  const say = (text: string) => store.ingestUpdate(update("message", message({ from: LOUIE, text })), "webhook");
  const join = async (q: { afterSeq?: number; since?: number } = {}) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    await hub.attach(socket, await hub.startCursor(q));
    await hub.pump();
    return socket;
  };

  beforeEach(() => {
    db = testDb();
    sockets = [];
    hub = new Hub(db, () => sockets.filter((s) => !s.closed), async () => IDENTITY);
    store = new Store(db, () => void hub.pump());
  });

  it("starts a socket with no cursor at now, then streams live", async () => {
    await say("before");
    const socket = await join();
    await say("after");
    await hub.pump();

    expect(socket.frames[0]).toEqual({ type: "hello", after_seq: 1, latest_seq: 1 });
    expect(socket.events().map((f) => (f.update as Row & { message: Row }).message.text)).toEqual(["after"]);
  });

  it("replays after the cursor, then goes live, with nothing twice or missing", async () => {
    for (const t of ["a", "b", "c"]) await say(t);
    const socket = await join({ afterSeq: 1 });
    await say("d");
    await hub.pump();
    expect(socket.frames[0]).toEqual({ type: "hello", after_seq: 1, latest_seq: 3 });
    expect(socket.seqs()).toEqual([2, 3, 4]);
  });

  it("resumes a killed client exactly where its last frame left off", async () => {
    const first = await join({ afterSeq: 0 });
    await say("a");
    await hub.pump();
    first.closed = true;
    const cursor = first.seqs().at(-1)!;
    await say("b");
    await say("c");

    const second = await join({ afterSeq: cursor });

    expect([...first.seqs(), ...second.seqs()]).toEqual([1, 2, 3]);
  });

  it("delivers writes that land while a pump is running", async () => {
    const socket = await join({ afterSeq: 0 });
    // Writes land while this pump is mid-drain; their pokes make it go round again.
    const running = hub.pump();
    for (const t of ["a", "b", "c"]) await say(t);
    await running;
    expect(socket.seqs()).toEqual([1, 2, 3]);
  });

  it("keeps a cursor per socket", async () => {
    for (const t of ["a", "b"]) await say(t);
    const late = await join({ afterSeq: 1 });
    const early = await join({ afterSeq: 0 });
    expect(late.seqs()).toEqual([2]);
    expect(early.seqs()).toEqual([1, 2]);
  });

  it("pages through a long replay", async () => {
    for (let i = 0; i < 250; i++) await say(`m${i}`);
    const socket = await join({ afterSeq: 0 });
    expect(socket.seqs()).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
  });

  it("starts from a time with since", async () => {
    db.sqlite.prepare("INSERT INTO events (recorded_at, source, payload) VALUES (100, 'telegram', '{}'), (200, 'telegram', '{}')").run();
    expect(await hub.startCursor({ since: 150 })).toBe(1);
    expect(await hub.startCursor({ since: 50 })).toBe(0);
  });
});

describe("Worker /stream", () => {
  const forwarded: Request[] = [];
  const env: Env = {
    DB: testDb(),
    MCP_AUTH_TOKEN: "test-secret",
    HUB: {
      idFromName: (name) => name,
      get: () => ({ fetch: async (r: Request) => { forwarded.push(r); return new Response(null, { status: 204 }); } }),
    },
  };
  const request = (query = "", headers: Record<string, string> = { authorization: "Bearer test-secret", upgrade: "websocket" }) =>
    worker.fetch(new Request(`https://worker.test/stream${query}`, { headers }), env);

  it("requires the MCP token", async () => {
    expect((await request("", { upgrade: "websocket" })).status).toBe(401);
  });

  it("requires a WebSocket upgrade", async () => {
    expect((await request("", { authorization: "Bearer test-secret" })).status).toBe(426);
  });

  it("validates the cursor", async () => {
    expect((await request("?after_seq=-1")).status).toBe(400);
    expect((await request("?after_seq=1&since=2")).status).toBe(400);
  });

  it("forwards to the hub with the cursor", async () => {
    forwarded.length = 0;
    await request("?after_seq=42&junk=1");
    expect(forwarded.map((r) => r.url)).toEqual(["https://hub/connect?after_seq=42"]);
  });
});
