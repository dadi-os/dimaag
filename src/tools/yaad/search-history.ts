import { z } from "zod";
import { defineTool } from "../types.js";
import { yaadToolCall } from "./call.js";

const input = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().optional(),
  })
  .strict();

/** Semantic search over Yaad node_history. */
export const searchHistory = defineTool({
  name: "yaad_search_history",
  description:
    "Semantic search across memory correction history (what changed in the graph over time).",
  input,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language history question" },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["query"],
  },
  async handler(ctx, parsed) {
    return yaadToolCall(
      () =>
        ctx.yaad.searchHistory({
          query: parsed.query,
          ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        }),
      (body) => body,
    );
  },
});
