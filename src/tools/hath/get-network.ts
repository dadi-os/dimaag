import { z } from "zod";
import { defineTool } from "../types.js";
import { hathToolCall } from "./call.js";

const input = z
  .object({
    node_name: z.string().min(1),
  })
  .strict();

/** Ask a Hath client for network / mesh connectivity details. */
export const getNetwork = defineTool({
  name: "hath_get_network",
  description:
    "Get network and mesh status from a Hath client (connection type, mesh up, optional SSID).",
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
    return hathToolCall(ctx, parsed.node_name, "hath_get_network");
  },
});
