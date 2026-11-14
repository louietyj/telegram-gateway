import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelegramClient, TelegramApiError, parseDataUri } from "../src/telegram/telegram-client.js";
import { Config } from "../src/core/config.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    botToken: "123:test-token",
    globalRateLimit: 100,
    perChatRateLimit: 100,
    maxRetries: 1,
    circuitBreakerThreshold: 5,
    circuitBreakerCooldown: 30000,
    maxFileSize: 50 * 1024 * 1024,
    ...overrides,
  };
}

describe("TelegramClient", () => {
  let client: TelegramClient;

  beforeEach(() => {
    client = new TelegramClient(makeConfig());
  });

  it("applies default chat_id", async () => {
    const clientWithDefault = new TelegramClient(makeConfig({ defaultChatId: "-100999" }));

    // Mock fetch to capture the request
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await clientWithDefault.call("sendMessage", { text: "hello" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.chat_id).toBe("-100999");

    vi.unstubAllGlobals();
    clientWithDefault.destroy();
  });

  it("does not override explicit chat_id with default", async () => {
    const clientWithDefault = new TelegramClient(makeConfig({ defaultChatId: "-100999" }));

    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: true }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await clientWithDefault.call("sendMessage", { chat_id: 42, text: "hello" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.chat_id).toBe(42);

    vi.unstubAllGlobals();
    clientWithDefault.destroy();
  });

  it("throws TelegramApiError on API error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        ok: false,
        error_code: 400,
        description: "Bad Request: chat not found",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(client.call("sendMessage", { chat_id: 1, text: "hi" }))
      .rejects.toThrow(TelegramApiError);

    vi.unstubAllGlobals();
  });

  it("masks token in error messages", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        ok: false,
        error_code: 400,
        description: "Unauthorized: token 123:test-token is invalid",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      await client.call("getMe", {});
    } catch (e) {
      expect((e as Error).message).not.toContain("123:test-token");
      expect((e as Error).message).toContain("***");
    }

    vi.unstubAllGlobals();
  });

  it("retries on 429 with retry_after", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          json: () => Promise.resolve({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 0 }, // 0 seconds for fast test
          }),
        });
      }
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true, result: true }),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const clientRetry = new TelegramClient(makeConfig({ maxRetries: 3 }));
    const result = await clientRetry.call("getMe", {});
    expect(result).toBe(true);
    expect(callCount).toBe(2);

    vi.unstubAllGlobals();
    clientRetry.destroy();
  });

  it("does not retry on 4xx errors (except 429)", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        json: () => Promise.resolve({
          ok: false,
          error_code: 400,
          description: "Bad Request: chat not found",
        }),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(client.call("sendMessage", { chat_id: 1, text: "hi" }))
      .rejects.toThrow(TelegramApiError);
    expect(callCount).toBe(1); // No retry on 400

    vi.unstubAllGlobals();
  });

  it("applies default thread_id", async () => {
    const clientWithThread = new TelegramClient(makeConfig({ defaultThreadId: 42 }));

    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: true }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await clientWithThread.call("sendMessage", { chat_id: 1, text: "hello" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.message_thread_id).toBe(42);

    vi.unstubAllGlobals();
    clientWithThread.destroy();
  });

  it("does not override explicit thread_id with default", async () => {
    const clientWithThread = new TelegramClient(makeConfig({ defaultThreadId: 42 }));

    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: true }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await clientWithThread.call("sendMessage", { chat_id: 1, text: "hello", message_thread_id: 99 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.message_thread_id).toBe(99);

    vi.unstubAllGlobals();
    clientWithThread.destroy();
  });

  const JPEG = "data:image/jpeg;base64,/9j/";

  it("uploads a data: URI as a multipart part named after the field", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await client.call("sendDocument", {
      chat_id: 1,
      document: "data:application/pdf;name=itinerary.pdf;base64,JVBERi0=",
      caption: "plan",
    });

    const form = mockFetch.mock.calls[0][1].body as FormData;
    const file = form.get("document") as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.name).toBe("itinerary.pdf");
    expect(file.type).toBe("application/pdf");
    expect(new TextDecoder().decode(await file.arrayBuffer())).toBe("%PDF-");
    expect(form.get("caption")).toBe("plan");
    expect(form.get("chat_id")).toBe("1");

    vi.unstubAllGlobals();
  });

  it("names an unnamed data: URI from its MIME type", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: {} }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await client.call("sendPhoto", { chat_id: 1, photo: JPEG });

    const form = mockFetch.mock.calls[0][1].body as FormData;
    expect((form.get("photo") as File).name).toBe("file.jpg");

    vi.unstubAllGlobals();
  });

  it("uploads data: URIs inside sendMediaGroup via attach://", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await client.call("sendMediaGroup", {
      chat_id: 1,
      media: [
        { type: "photo", media: JPEG, caption: "a" },
        { type: "photo", media: "AgACAgIAAxkBAAI-file-id" },
        { type: "photo", media: JPEG },
      ],
    });

    const form = mockFetch.mock.calls[0][1].body as FormData;
    const media = JSON.parse(form.get("media") as string);
    expect(media.map((m: { media: string }) => m.media))
      .toEqual(["attach://file0", "AgACAgIAAxkBAAI-file-id", "attach://file1"]);
    expect(form.get("file0")).toBeInstanceOf(Blob);
    expect(form.get("file1")).toBeInstanceOf(Blob);

    vi.unstubAllGlobals();
  });

  it("uploads data: URIs inside rich_message.media (passed as a JSON string)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: {} }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await client.call("sendRichMessage", {
      chat_id: 1,
      rich_message: JSON.stringify({
        markdown: "![](tg://video?id=trailer \"Caption\")",
        media: [{ id: "trailer", media: { type: "video", media: "data:video/mp4;base64,AAAAGA==", cover: JPEG } }],
      }),
    });

    const form = mockFetch.mock.calls[0][1].body as FormData;
    const rich = JSON.parse(form.get("rich_message") as string);
    expect(rich.media[0].id).toBe("trailer");
    expect(rich.media[0].media.media).toBe("attach://file0");
    expect(rich.media[0].media.cover).toBe("attach://file1");

    vi.unstubAllGlobals();
  });

  it("passes absolute paths through as plain strings, never reading the disk", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error_code: 400, description: "Bad Request: wrong file identifier" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(client.call("sendDocument", { chat_id: 1, document: "/etc/passwd" })).rejects.toThrow(TelegramApiError);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).document).toBe("/etc/passwd");

    vi.unstubAllGlobals();
  });

  it("rejects malformed data: URIs", () => {
    expect(() => parseDataUri("data:image/png;base64")).toThrow(/no comma/);
    expect(() => parseDataUri("data:image/png;base64,***")).toThrow(/invalid base64/);
    expect(new TextDecoder().decode(parseDataUri("data:,hi%20there").bytes)).toBe("hi there");
  });

  it("accepts media passed as a JSON string", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await client.call("sendMediaGroup", {
      chat_id: 1,
      media: JSON.stringify([{ type: "photo", media: "AgACAgIAAxkBAAI-file-id" }]),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(Array.isArray(body.media)).toBe(true);
    expect(body.media[0].media).toBe("AgACAgIAAxkBAAI-file-id");

    vi.unstubAllGlobals();
  });

  it("uploads media URLs as multipart instead of letting Telegram fetch them", async () => {
    // Telegram's own URL fetching caps at 5 MB for photos and 20 MB for other files.
    const videoBytes = Buffer.alloc(64, 7);
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).startsWith("https://cdn.example.com/")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "video/mp4" }),
          arrayBuffer: () => Promise.resolve(videoBytes.buffer.slice(0)),
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, result: { message_id: 7 } }) });
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await client.call("sendVideo", {
      chat_id: 1,
      video: "https://cdn.example.com/clip.mp4",
    });

    expect(result).toEqual({ message_id: 7 });
    const apiCall = mockFetch.mock.calls.find((c) => String(c[0]).includes("api.telegram.org"))!;
    expect(apiCall[1].body).toBeInstanceOf(FormData);
    expect((apiCall[1].body as FormData).get("video")).toBeInstanceOf(Blob);

    vi.unstubAllGlobals();
  });

  it("uploads every URL inside a media group", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).startsWith("https://cdn.example.com/")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: () => Promise.resolve(Buffer.alloc(8).buffer.slice(0)),
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, result: [] }) });
    });
    vi.stubGlobal("fetch", mockFetch);

    await client.call("sendMediaGroup", {
      chat_id: 1,
      media: [
        { type: "photo", media: "https://cdn.example.com/a.jpg" },
        { type: "photo", media: "https://cdn.example.com/b.jpg" },
      ],
    });

    const apiCall = mockFetch.mock.calls.find((c) => String(c[0]).includes("api.telegram.org"))!;
    const form = apiCall[1].body as FormData;
    const media = JSON.parse(form.get("media") as string);
    expect(media.map((m: { media: string }) => m.media)).toEqual(["attach://file0", "attach://file1"]);

    vi.unstubAllGlobals();
  });

  it("reports an unreachable link instead of hiding it", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).startsWith("https://cdn.example.com/")) {
        return Promise.resolve({ ok: false, status: 403, headers: new Headers() });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, result: {} }) });
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(client.call("sendVideo", { chat_id: 1, video: "https://cdn.example.com/clip.mp4" }))
      .rejects.toThrow(/HTTP 403/);
    // Nothing was sent to Telegram — the failure is surfaced, not papered over.
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("api.telegram.org"))).toBe(false);

    vi.unstubAllGlobals();
  });

  it("reports a file over the upload limit with its real size", async () => {
    const small = new TelegramClient(makeConfig({ maxFileSize: 32 }));
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).startsWith("https://cdn.example.com/")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "video/mp4" }),
          arrayBuffer: () => Promise.resolve(Buffer.alloc(1024).buffer.slice(0)),
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, result: {} }) });
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(small.call("sendVideo", { chat_id: 1, video: "https://cdn.example.com/big.mp4" }))
      .rejects.toThrow(/Telegram accepts at most/);

    vi.unstubAllGlobals();
    small.destroy();
  });

  afterEach(() => {
    client.destroy();
  });
});
