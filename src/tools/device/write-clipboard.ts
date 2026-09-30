import { z } from "zod";
import { defineTool } from "../types.js";
import { deviceToolCall } from "./call.js";

const input = z
  .object({
    node_name: z.string().min(1),
    text: z.string(),
  })
  .strict();

/** Write text onto a device's clipboard. */
export const writeClipboard = defineTool({
  name: "device_write_clipboard",
  description:
    "Replace the clipboard text on a device with the given string.",
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
    return deviceToolCall(ctx, parsed.node_name, "device_write_clipboard", {
      text: parsed.text,
    });
  },
});
