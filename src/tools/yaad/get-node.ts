import { z } from "zod";
import { defineTool } from "../types.js";
import { yaadToolCall } from "./call.js";

const input = z.object({
  id: z.string().uuid(),
});

/** Fetch one Yaad node with detail and incident edges. */
export const getNode = defineTool({
  name: "get_node",
  description:
    "Fetch one memory node in full, including its detail and all its current edges. Use this after recall or query when you need a node's connections — for example resolving an event's AT_LOCATION edge to get a place's address and coordinates.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Node uuid" },
    },
    required: ["id"],
  },
  async handler(ctx, parsed) {
    return yaadToolCall(
      () => ctx.yaad.getNode(parsed.id),
      (response) => response,
    );
  },
});
