import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

/** Host + module health from Nas GET /status. */
export const getStatus = defineTool({
  name: "nas_get_status",
  description:
    "Read host uptime, per-module health probes, and resource samples (disk/cpu/memory/gpu) from Nas.",
  input: z.object({}).strict(),
  inputSchema: { type: "object", properties: {}, required: [] },
  async handler(ctx) {
    return nasToolCall(
      () => ctx.nas.getStatus(),
      (status) => status,
    );
  },
});
