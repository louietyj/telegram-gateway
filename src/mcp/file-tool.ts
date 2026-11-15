import type { Api } from "grammy";
import { type LocalTool, localTool } from "./local-tool.js";

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

/** Telegram's file URL embeds the bot token, so files are fetched here and returned as content. */
async function fetchFile(api: Api, token: string, fileId: string) {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram returned no file_path (files over 20 MB can't be fetched by bots)");
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  } catch (error) {
    throw new Error((error as Error).message.replaceAll(token, "***"));
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { fileName: file.file_path.split("/").pop() ?? fileId, data: await response.arrayBuffer() };
}

export function downloadFileTool(api: Api, token: string): LocalTool {
  return localTool({
    name: "downloadFile",
    description:
      "Fetch a Telegram file by file_id (from history* media, e.g. [photo file_id=…]) and return its bytes: " +
      "images as image content you can look at, anything else as a binary resource. The bot token never " +
      "leaves the Worker. Telegram serves bots files up to 20 MB.",
    inputSchema: {
      type: "object",
      properties: { file_id: { type: "string", description: "file_id from a message's media" } },
      required: ["file_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const { fileName, data } = await fetchFile(api, token, args.file_id as string)
      .catch((error: Error) => {
        throw new Error(`downloadFile failed: ${error.message}`);
      });
    const mimeType = mimeFor(fileName);
    const base64 = toBase64(data);
    if (mimeType.startsWith("image/")) {
      return { content: [{ type: "image", data: base64, mimeType }] };
    }
    return {
      content: [{
        type: "resource",
        resource: { uri: `telegram-file:///${encodeURIComponent(fileName)}`, mimeType, blob: base64 },
      }],
    };
  });
}
