import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TelegramClient } from "../telegram/telegram-client.js";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav",
  pdf: "application/pdf", txt: "text/plain", json: "application/json", zip: "application/zip",
};

function mimeFor(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function registerFileTool(server: McpServer, client: TelegramClient): void {
  server.tool(
    "download_file",
    "Fetch a Telegram file by file_id (from history_* media, e.g. [photo file_id=…]) and return its bytes: " +
      "images as image content you can look at, anything else as a binary resource. The bot token never " +
      "leaves the Worker. Telegram serves bots files up to 20 MB.",
    { file_id: z.string().describe("file_id from a message's media") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ file_id }) => {
      try {
        const { fileName, data } = await client.fetchFile(file_id);
        const mimeType = mimeFor(fileName);
        const base64 = toBase64(data);
        if (mimeType.startsWith("image/")) {
          return { content: [{ type: "image" as const, data: base64, mimeType }] };
        }
        return {
          content: [{
            type: "resource" as const,
            resource: { uri: `telegram-file:///${encodeURIComponent(fileName)}`, mimeType, blob: base64 },
          }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `download_file failed: ${(error as Error).message}` }], isError: true };
      }
    }
  );
}
