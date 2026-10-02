import { z } from "zod";
import { defineTool } from "../types.js";
import { surveyDevices } from "./call.js";

const input = z.object({}).strict();

/** Ask every device for its current geolocation. */
export const getLocation = defineTool({
  name: "device_get_location",
  description:
    "Get latitude, longitude, accuracy (meters), UTC timestamp, and a human address when available from every enrolled device (street address on Apple via reverse geocode; city/region on Windows). A device answers with permission_denied when location access is not granted, capability_unsupported on platforms without a native location API. Every device is listed with online and last_seen from the mesh and app_running from its heartbeat, so offline and app-closed devices show up too; only devices with the app running answer, with result or error.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  async handler(ctx) {
    return surveyDevices(ctx, "device_get_location");
  },
});
