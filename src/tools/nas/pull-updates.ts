import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    scope: z.enum(["modules", "os", "all"]),
  })
  .strict();

/** Start module and/or OS updates via Nas POST /pull_updates (runs in the background). */
export const pullUpdates = defineTool({
  name: "nas_pull_updates",
  description:
    "Start updates in the background and return the run immediately (state=running). scope=modules updates app containers (Dimaag may restart); scope=os runs bootc upgrade (podman only); scope=all does both. When an OS deployment is staged the box reboots on its own. Poll nas_get_update_status for the outcome; fails with busy if a run is already in flight.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["modules", "os", "all"],
        description: "What to update",
      },
    },
    required: ["scope"],
  },
  async handler(ctx, parsed) {
    return nasToolCall(
      () => ctx.nas.pullUpdates(parsed.scope),
      (body) => body,
    );
  },
});
