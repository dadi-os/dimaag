import { z } from "zod";
import { defineTool } from "../types.js";
import { surveyDevices } from "./call.js";

const input = z.object({}).strict();

/** Ask every device for device identity and OS details. */
export const getInfo = defineTool({
  name: "device_get_info",
  description:
    "Get identity and environment from every enrolled device: platform, OS version, app version, timezone. Every device is listed with online and last_seen from the mesh and app_running from its heartbeat, so offline and app-closed devices show up too; only devices with the app running answer, with result or error.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  async handler(ctx) {
    return surveyDevices(ctx, "device_get_info");
  },
});
