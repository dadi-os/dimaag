import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

/** Latest pull_updates run from Nas GET /pull_updates. */
export const getUpdateStatus = defineTool({
  name: "nas_get_update_status",
  description:
    "Read the latest nas_pull_updates run: state (idle, running, succeeded, rebooting, failed), scope, timestamps, reboot_required, and error. The run is held in Nas memory, so it resets to idle after a reboot or Nas restart.",
  input: z.object({}).strict(),
  inputSchema: { type: "object", properties: {}, required: [] },
  async handler(ctx) {
    return nasToolCall(
      () => ctx.nas.getUpdateStatus(),
      (run) => run,
    );
  },
});
