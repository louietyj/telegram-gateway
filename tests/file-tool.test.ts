import { describe, it, expect, afterEach, vi } from "vitest";
import { testDb } from "./helpers/d1.js";
import { connect, stubTelegram } from "./helpers/mcp.js";

/** getFile goes through grammY; the download itself is a plain fetch of the file URL. */
function stubFiles(filePath: string, bytes: Uint8Array) {
  stubTelegram(() => ({ file_id: "F", file_unique_id: "u", file_path: filePath }));
  const fetchMock = vi.fn(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("downloadFile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a photo as image content", async () => {
    const fetchMock = stubFiles("photos/file_1.jpg", new Uint8Array([0xff, 0xd8, 0xff]));
    const { call } = await connect(testDb());

    const res = await call("downloadFile", { file_id: "F" });

    expect(res.content).toEqual([{ type: "image", data: "/9j/", mimeType: "image/jpeg" }]);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.telegram.org/file/bot123:test-token/photos/file_1.jpg");
    expect(JSON.stringify(res)).not.toContain("test-token");
  });

  it("returns other files as a binary resource", async () => {
    stubFiles("documents/plan.pdf", new TextEncoder().encode("%PDF-"));
    const { call } = await connect(testDb());

    const res = await call("downloadFile", { file_id: "F" });

    expect(res.content).toEqual([{
      type: "resource",
      resource: { uri: "telegram-file:///plan.pdf", mimeType: "application/pdf", blob: "JVBERi0=" },
    }]);
  });

  it("reports failures without leaking the token", async () => {
    stubTelegram(() => ({ file_id: "F", file_unique_id: "u", file_path: "photos/x.jpg" }));
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect failed: https://api.telegram.org/file/bot123:test-token/x");
    }));
    const { call } = await connect(testDb());

    const res = await call("downloadFile", { file_id: "F" });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/downloadFile failed: connect failed/);
    expect(res.text).not.toContain("test-token");
  });
});
