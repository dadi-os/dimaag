import { z } from "zod";
import { defineTool } from "../types.js";
import { surveyDevices } from "./call.js";

const input = z.object({}).strict();

/** Ask every device for network / mesh connectivity details. */
export const getNetwork = defineTool({
  name: "device_get_network",
  description:
    "Get network and mesh status from every enrolled device (connection type, mesh up, optional SSID). Every device is listed with online and last_seen from the mesh and app_running from its heartbeat, so offline and app-closed devices show up too; only devices with the app running answer, with result or error.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  async handler(ctx) {
    return surveyDevices(ctx, "device_get_network");
  },
});
