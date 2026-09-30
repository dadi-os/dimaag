import { z } from "zod";
import { defineTool } from "../types.js";
import { deviceToolCall } from "./call.js";

const input = z
  .object({
    node_name: z.string().min(1),
  })
  .strict();

/** Ask a device for battery level and charging state. */
export const getBattery = defineTool({
  name: "device_get_battery",
  description:
    "Get battery percent and charging state from a device. Fails with capability_unsupported when the OS does not expose battery data.",
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
    return deviceToolCall(ctx, parsed.node_name, "device_get_battery");
  },
});
