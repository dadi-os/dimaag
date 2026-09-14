import { z } from "zod";
import { defineTool } from "../types.js";
import { hathToolCall } from "./call.js";

const input = z
  .object({
    node_name: z.string().min(1),
  })
  .strict();

/** Read the clipboard text on a Hath client. */
export const readClipboard = defineTool({
  name: "hath_read_clipboard",
  description:
    "Read the current clipboard text from a Hath client. Fails with permission_denied when clipboard access is blocked.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      node_name: { type: "string", description: "Mesh node name from nas_list_clients" },
    },
    required: ["node_name"],
  },
  async handler(ctx, parsed) {
    return hathToolCall(ctx, parsed.node_name, "hath_read_clipboard");
  },
});
