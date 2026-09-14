import { z } from "zod";
import { defineTool } from "../types.js";
import { yaadToolCall } from "./call.js";

const input = z
  .object({
    node_id: z.string().uuid(),
  })
  .strict();

/** Fetch correction history for one Yaad node. */
export const getNodeHistory = defineTool({
  name: "yaad_get_node_history",
  description:
    "List field-level corrections for one memory node (title/body/occurred_at/deleted), newest first.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", format: "uuid" },
    },
    required: ["node_id"],
  },
  async handler(ctx, parsed) {
    return yaadToolCall(
      () => ctx.yaad.getNodeHistory(parsed.node_id),
      (body) => body,
    );
  },
});
