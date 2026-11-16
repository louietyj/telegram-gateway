import { D1Like } from "../store/db.js";
import { BotIdentity, EventRow, eventFrame, helloFrame } from "./frames.js";

/** The part of a hibernatable WebSocket the hub uses. */
export interface StreamSocket {
  send(data: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface Attachment {
  cursor: number;
}

const PAGE = 100;

/**
 * Pushes the event stream to every connected socket. Each socket's cursor lives in its
 * attachment (so it survives hibernation) and moves only after a frame is sent. A pump reads
 * `seq > cursor` per socket; a poke during a pump makes it run again. So replay and live
 * delivery are one path: nothing is skipped and nothing is sent twice.
 */
export class Hub {
  private pumping = false;
  private again = false;

  constructor(
    private db: D1Like,
    private sockets: () => StreamSocket[],
    private bot: () => Promise<BotIdentity>,
  ) {}

  /** Where a new connection starts: after `afterSeq`, after the last event before `since`, or now. */
  async startCursor(q: { afterSeq?: number; since?: number }): Promise<number> {
    if (q.afterSeq !== undefined) return q.afterSeq;
    if (q.since === undefined) return this.latestSeq();
    const row = await this.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE recorded_at < ?")
      .bind(q.since).first<{ seq: number | null }>();
    return row?.seq ?? 0;
  }

  /** Greets the socket with where it starts and where replay ends, then registers its cursor. */
  async attach(socket: StreamSocket, cursor: number): Promise<void> {
    socket.serializeAttachment({ cursor } satisfies Attachment);
    socket.send(helloFrame(cursor, await this.latestSeq()));
  }

  private async latestSeq(): Promise<number> {
    const row = await this.db.prepare("SELECT MAX(seq) AS seq FROM events").first<{ seq: number | null }>();
    return row?.seq ?? 0;
  }

  async pump(): Promise<void> {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        for (const socket of this.sockets()) await this.drain(socket);
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }

  private async drain(socket: StreamSocket): Promise<void> {
    for (;;) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (!attachment) return;
      const { results } = await this.db.prepare(
        "SELECT seq, recorded_at, source, client, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?"
      ).bind(attachment.cursor, PAGE).all<EventRow>();
      if (results.length === 0) return;
      const bot = await this.bot();
      for (const row of results) {
        try {
          socket.send(eventFrame(row, bot));
        } catch {
          return; // closed; the runtime drops it from getWebSockets()
        }
        socket.serializeAttachment({ cursor: row.seq } satisfies Attachment);
      }
      if (results.length < PAGE) return;
    }
  }
}
