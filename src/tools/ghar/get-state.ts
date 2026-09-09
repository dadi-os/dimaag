import { z } from "zod";
import { defineTool } from "../types.js";
import { gharToolCall } from "./call.js";

const input = z
  .object({
    device_ids: z.array(z.string().uuid()).min(1),
  })
  .strict();

/**
 * Current attribute values with last-changed timestamps via Ghar `GET /state`.
 * last-changed is the point: staleness questions are answerable in one call.
 */
export const getState = defineTool({
  name: "get_state",
  description:
    'Read the current values for one or more devices, including how long each value has held (`changed_at`). Use this for questions like "has the hall been empty for a while" or "how long has that light been on" — answer from last-changed here in one call rather than reading event history.',
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      device_ids: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Device ids to read",
      },
    },
    required: ["device_ids"],
  },
  async handler(ctx, parsed) {
    const wanted = new Set(parsed.device_ids);
    return gharToolCall(
      () => ctx.ghar.getState(),
      (response) => {
        const devices: Record<string, (typeof response.devices)[string]> = {};
        for (const deviceId of wanted) {
          devices[deviceId] = response.devices[deviceId] ?? {};
        }
        return { devices };
      },
    );
  },
});
