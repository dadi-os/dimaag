import { z } from "zod";
import { defineTool } from "../types.js";
import { hathToolCall } from "./call.js";

const input = z
  .object({
    node_name: z.string().min(1),
  })
  .strict();

/** Ask a Hath client for device identity and OS details. */
export const getInfo = defineTool({
  name: "hath_get_info",
  description:
    "Get identity and environment for a Hath client: node_name, platform, OS version, app version, timezone. Use nas_list_clients first when you do not already know node_name.",
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
    return hathToolCall(ctx, parsed.node_name, "hath_get_info");
  },
});
