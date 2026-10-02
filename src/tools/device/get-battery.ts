import { z } from "zod";
import { defineTool } from "../types.js";
import { surveyDevices } from "./call.js";

const input = z.object({}).strict();

/** Ask every device for battery level and charging state. */
export const getBattery = defineTool({
  name: "device_get_battery",
  description:
    "Get battery percent and charging state from every enrolled device. A device whose OS does not expose battery data answers with capability_unsupported. Every device is listed with online and last_seen from the mesh and app_running from its heartbeat, so offline and app-closed devices show up too; only devices with the app running answer, with result or error.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  async handler(ctx) {
    return surveyDevices(ctx, "device_get_battery");
  },
});
