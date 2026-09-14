import { z } from "zod";
import { defineTool } from "../types.js";
import { hathToolCall } from "./call.js";

const input = z
  .object({
    node_name: z.string().min(1),
    filename: z.string().min(1),
    media_type: z.string().min(1),
    data: z.string().min(1),
  })
  .strict();

/** Save a file into a Hath client's default Downloads folder. */
export const sendFile = defineTool({
  name: "hath_send_file",
  description:
    "Write a file into the Hath client's OS Downloads folder. data is raw base64 (no data-URL prefix). Returns the absolute path written on the device.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      node_name: { type: "string", description: "Mesh node name from nas_list_clients" },
      filename: { type: "string", description: "File name only (no path separators)" },
      media_type: { type: "string", description: "MIME type of the payload" },
      data: { type: "string", description: "Base64 file bytes without a data-URL prefix" },
    },
    required: ["node_name", "filename", "media_type", "data"],
  },
  async handler(ctx, parsed) {
    return hathToolCall(ctx, parsed.node_name, "hath_send_file", {
      filename: parsed.filename,
      media_type: parsed.media_type,
      data: parsed.data,
    });
  },
});
