import { z } from "zod";
import { defineTool } from "../types.js";
import { deviceToolCall } from "./call.js";

const input = z
  .object({
    node_name: z.string().min(1),
  })
  .strict();

/** Ask a device for its current geolocation. */
export const getLocation = defineTool({
  name: "device_get_location",
  description:
    "Get latitude, longitude, accuracy (meters), UTC timestamp, and a human address when available from a device (street address on Apple via reverse geocode; city/region on Windows). Fails with permission_denied when the user has not granted location access; capability_unsupported on platforms without a native location API.",
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
    return deviceToolCall(ctx, parsed.node_name, "device_get_location");
  },
});
