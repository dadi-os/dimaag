import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z.object({}).strict();

/** List host terminals via Nas `GET /terminals`. Intended for managers. */
export const listTerminals = defineTool({
  name: "list_terminals",
  description:
    "List live host terminals (id, cwd, created_at, busy). Busy means a command is still running in that pane.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  async handler(ctx) {
    return nasToolCall(
      () => ctx.nas.listTerminals(),
      (terminals) => ({ terminals }),
    );
  },
});
