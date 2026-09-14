import { z } from "zod";
import { defineTool } from "../types.js";
import { hathToolCall } from "./call.js";

const input = z
  .object({
    node_name: z.string().min(1),
  })
  .strict();

/** Ask a Hath client for its current geolocation. */
export const getLocation = defineTool({
  name: "hath_get_location",
  description:
    "Get latitude, longitude, accuracy (meters), and timestamp from a Hath client. Fails with permission_denied when the user has not granted location access.",
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
    return hathToolCall(ctx, parsed.node_name, "hath_get_location");
  },
});
