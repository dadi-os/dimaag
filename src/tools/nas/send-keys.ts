import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    terminal_id: z.string().min(1),
    keys: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** Send raw tmux keys to a terminal via Nas. Intended for workers. */
export const sendKeys = defineTool({
  name: "send_keys",
  description:
    "Send keystrokes to a host terminal (tmux send-keys). Examples: [\"C-c\"] to interrupt a running command, [\"y\", \"Enter\"] to answer a prompt. Use after execute_shell times out when you need to stop or interact with the still-running process.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["terminal_id", "keys"],
    properties: {
      terminal_id: { type: "string", description: "Terminal id" },
      keys: {
        type: "array",
        items: { type: "string" },
        description: 'Key names passed verbatim to tmux, e.g. ["C-c"] or ["Enter"]',
      },
    },
  },
  async handler(ctx, parsed) {
    return nasToolCall(
      () => ctx.nas.sendKeys(parsed.terminal_id, { keys: parsed.keys }),
      (response) => response,
      { terminal_id: parsed.terminal_id },
    );
  },
});
