import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    scope: z.enum(["modules", "os", "all"]),
  })
  .strict();

/** Apply module and/or OS updates via Nas POST /pull_updates. */
export const pullUpdates = defineTool({
  name: "nas_pull_updates",
  description:
    "Pull and apply updates. scope=modules updates app containers; scope=os runs bootc upgrade (podman only); scope=all does both. Does not reboot — check reboot_required.",
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
