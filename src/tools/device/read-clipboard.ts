import { z } from "zod";
import { defineTool } from "../types.js";
import { deviceToolCall } from "./call.js";

const input = z
  .object({
    node_name: z.string().min(1),
  })
  .strict();

/** Read the clipboard text on a device. */
export const readClipboard = defineTool({
  name: "device_read_clipboard",
  description:
    "Read the current clipboard text from a device. Fails with permission_denied when clipboard access is blocked.",
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
    return deviceToolCall(ctx, parsed.node_name, "device_read_clipboard");
  },
});
