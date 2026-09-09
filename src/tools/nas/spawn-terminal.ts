import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    cwd: z.string().min(1).optional(),
  })
  .strict();

/** Create a host terminal via Nas `POST /terminals`. Intended for managers. */
export const spawnTerminal = defineTool({
  name: "spawn_terminal",
  description:
    "Start a new host terminal session. Returns a terminal_id that you hand to a worker (in its system prompt or a message). Optional cwd defaults to Nas state dir (dadi home).",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      cwd: {
        type: "string",
        description: "Absolute working directory for the new session (defaults to Nas state dir)",
      },
    },
  },
  async handler(ctx, parsed) {
    const body = parsed.cwd !== undefined ? { cwd: parsed.cwd } : {};
    return nasToolCall(
      () => ctx.nas.createTerminal(body),
      (response) => ({ terminal_id: response.id, cwd: response.cwd }),
      (response) => ({ terminal_id: response.id }),
    );
  },
});
