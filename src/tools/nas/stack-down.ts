import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

/** Take the app stack down via Nas POST /stack/down. */
export const stackDown = defineTool({
  name: "nas_stack_down",
  description: "Stop the dadi app stack (compose down or ordered systemd stops).",
  input: z.object({}).strict(),
  inputSchema: { type: "object", properties: {}, required: [] },
  async handler(ctx) {
    return nasToolCall(
      () => ctx.nas.stackDown(),
      (body) => body,
    );
  },
});
