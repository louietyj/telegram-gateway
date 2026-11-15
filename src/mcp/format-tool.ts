import { FORMATS, findFormat, formatIndex } from "./formats.js";
import { type LocalTool, localTool, READ_ONLY, text } from "./local-tool.js";

/**
 * A JSON Schema can say `rich_message: object`; it cannot teach an agent what a rich
 * post is or how its markdown works. This tool answers that question before anything
 * is sent, so a malformed post never reaches a channel to find out.
 */
export function formatTool(): LocalTool {
  return localTool({
    name: "telegramFormat",
    description:
      "Ask what shape a structured Telegram parameter must have BEFORE sending. Call this whenever you " +
      "are about to build a rich post, an album, a keyboard, or a poll and are not certain of the exact " +
      "syntax. Topics: " + FORMATS.map((f) => f.topic).join(", ") + ". Omit the topic to list them all. " +
      "For a post longer than a 1024-character caption, ask for 'rich_message'.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Format to explain — a topic ('rich_message', 'media', 'reply_markup', 'poll'), a tool name " +
            "('sendRichMessage', 'sendMediaGroup'), or plain wording ('long post', 'table', 'album', 'buttons')",
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  }, async (args) => {
    const topic = args.topic as string | undefined;
    if (!topic) return formatIndex();
    const doc = findFormat(topic);
    if (!doc) return text(`No format named "${topic}".\n\n${formatIndex()}`, true);
    return `${doc.body}\n\n---\nApplies to: ${doc.applies}`;
  });
}
