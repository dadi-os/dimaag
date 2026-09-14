import { z } from "zod";
import { defineTool } from "../types.js";
import { hathToolCall } from "./call.js";

const input = z
  .object({
    node_name: z.string().min(1),
    text: z.string(),
  })
  .strict();

/** Write text onto a Hath client's clipboard. */
export const writeClipboard = defineTool({
  name: "hath_write_clipboard",
  description:
    "Replace the clipboard text on a Hath client with the given string.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      node_name: { type: "string", description: "Mesh node name from nas_list_clients" },
      text: { type: "string", description: "Exact clipboard contents to set" },
    },
    required: ["node_name", "text"],
  },
  async handler(ctx, parsed) {
    return hathToolCall(ctx, parsed.node_name, "hath_write_clipboard", {
      text: parsed.text,
    });
  },
});
