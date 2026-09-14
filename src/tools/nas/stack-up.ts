import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

/** Bring the app stack up via Nas POST /stack/up. */
export const stackUp = defineTool({
  name: "nas_stack_up",
  description: "Start the dadi app stack (compose up or ordered systemd starts).",
  input: z.object({}).strict(),
  inputSchema: { type: "object", properties: {}, required: [] },
  async handler(ctx) {
    return nasToolCall(
      () => ctx.nas.stackUp(),
      (body) => body,
    );
  },
});
