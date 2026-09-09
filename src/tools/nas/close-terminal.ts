import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    terminal_id: z.string().min(1),
  })
  .strict();

/** Kill a host terminal via Nas `DELETE /terminals/{id}`. Intended for managers. */
export const closeTerminal = defineTool({
  name: "close_terminal",
  description: "Destroy a host terminal session by id. Fails loudly if the terminal does not exist.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["terminal_id"],
    properties: {
      terminal_id: { type: "string", description: "Terminal id from spawn_terminal (e.g. t1)" },
    },
  },
  async handler(ctx, parsed) {
    return nasToolCall(
      async () => {
        await ctx.nas.closeTerminal(parsed.terminal_id);
        return { closed: true as const };
      },
      (response) => response,
      { terminal_id: parsed.terminal_id },
    );
  },
});
