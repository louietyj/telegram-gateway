import type { D1Like } from "../store/db.js";
import type { BotIdentity } from "./frames.js";
import { Hub, type StreamSocket } from "./hub.js";

/** The Workers runtime types this file uses (the repo doesn't depend on @cloudflare/workers-types). */
interface CfWebSocket extends StreamSocket {
  close(code?: number, reason?: string): void;
}

interface DurableObjectState {
  acceptWebSocket(socket: CfWebSocket): void;
  getWebSockets(): CfWebSocket[];
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

declare const WebSocketPair: new () => { 0: CfWebSocket; 1: CfWebSocket };

interface HubEnv {
  DB: D1Like;
  TELEGRAM_BOT_TOKEN?: string;
}

/**
 * One instance holds every /stream socket, hibernating between events. The Worker forwards
 * authenticated upgrades to /connect and pokes /poke after each write to the event stream.
 */
export class StreamHub {
  private hub: Hub;
  private identity?: BotIdentity;

  constructor(private state: DurableObjectState, private env: HubEnv) {
    this.hub = new Hub(env.DB, () => state.getWebSockets(), () => this.botIdentity());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/poke") {
      await this.hub.pump();
      return new Response(null, { status: 204 });
    }

    const param = (name: string) => (url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined);
    const cursor = await this.hub.startCursor({ afterSeq: param("after_seq"), since: param("since") });
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    await this.hub.attach(pair[1], cursor);
    void this.hub.pump().catch((error) => console.error("replay failed", (error as Error).message));
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /** The socket is read-only: anything a client sends is ignored. */
  webSocketMessage(): void {}

  webSocketClose(socket: CfWebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // 1005/1006 can't be echoed; the socket is gone either way.
    }
  }

  /** The bot's id is in its token; its username (for @mentions) comes from getMe, once. */
  private async botIdentity(): Promise<BotIdentity> {
    if (this.identity) return this.identity;
    const token = this.env.TELEGRAM_BOT_TOKEN ?? "";
    const id = Number(token.split(":")[0]);
    let username = (await this.state.storage.get<string>("bot_username")) ?? null;
    if (username === null && token) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const body = (await res.json()) as { ok: boolean; result?: { username?: string } };
        username = body.result?.username ?? null;
        if (username) await this.state.storage.put("bot_username", username);
      } catch (error) {
        console.error("getMe failed", (error as Error).message);
      }
    }
    const identity = { id, username };
    if (username) this.identity = identity; // else retry getMe on the next pump
    return identity;
  }
}
