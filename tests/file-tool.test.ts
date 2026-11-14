import { describe, it, expect, afterEach, vi } from "vitest";
import { testDb } from "./helpers/d1.js";
import { connect } from "./helpers/mcp.js";

function stubFiles(filePath: string, bytes: Uint8Array) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_id: "F", file_path: filePath } }));
    }
    return new Response(bytes);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("download_file", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a photo as image content", async () => {
    const fetchMock = stubFiles("photos/file_1.jpg", new Uint8Array([0xff, 0xd8, 0xff]));
    const { call } = await connect(testDb());

    const res = await call("download_file", { file_id: "F" });

    expect(res.content).toEqual([{ type: "image", data: "/9j/", mimeType: "image/jpeg" }]);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://api.telegram.org/file/bot123:test-token/photos/file_1.jpg");
    expect(JSON.stringify(res)).not.toContain("test-token");
  });

  it("returns other files as a binary resource", async () => {
    stubFiles("documents/plan.pdf", new TextEncoder().encode("%PDF-"));
    const { call } = await connect(testDb());

    const res = await call("download_file", { file_id: "F" });

    expect(res.content).toEqual([{
      type: "resource",
      resource: { uri: "telegram-file:///plan.pdf", mimeType: "application/pdf", blob: "JVBERi0=" },
    }]);
  });

  it("reports failures without leaking the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect failed: https://api.telegram.org/file/bot123:test-token/x");
    }));
    const { call } = await connect(testDb());

    const res = await call("download_file", { file_id: "F" });

    expect(res.isError).toBe(true);
    expect(res.text).not.toContain("test-token");
  });
});
