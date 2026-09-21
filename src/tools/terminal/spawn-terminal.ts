import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    terminal_id: z
      .string()
      .regex(/^t[1-9]\d*$/)
      .optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();

/** Create a host terminal via Nas `POST /terminals`. Intended for managers. */
export const spawnTerminal = defineTool({
  name: "terminal_spawn",
  description:
    "Start a host terminal session. Pass terminal_id to create that session if it is not already running; the shell is new, because a closed session keeps no history. Omit terminal_id to allocate the lowest unused name, which is always a new shell. Returns a terminal_id that you hand to a worker (in its system prompt or a message). Optional cwd defaults to Nas state dir (dadi home). Fails if that id is already running.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      terminal_id: {
        type: "string",
        description:
          "Session name to start again, such as t3. Omit to allocate the lowest unused name. A new shell either way.",
      },
      cwd: {
        type: "string",
        description: "Absolute working directory for the new session (defaults to Nas state dir)",
      },
    },
  },
  async handler(ctx, parsed) {
    const body = {
      ...(parsed.terminal_id !== undefined ? { id: parsed.terminal_id } : {}),
      ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
    };
    return nasToolCall(
      () => ctx.nas.createTerminal(body),
      (response) => ({ terminal_id: response.id, cwd: response.cwd }),
      (response) => ({ terminal_id: response.id }),
    );
  },
});
