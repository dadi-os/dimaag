import { z } from "zod";
import { defineTool } from "../types.js";
import { yaadToolCall } from "./call.js";

const input = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
});

export const recall = defineTool({
  name: "recall",
  description:
    'Search memory by meaning. Use this for open questions about people, past events, preferences, and anything you\'d answer with "what do I know about X." Returns ranked results with a `sufficient` flag — when that is false, the memory graph did not have enough to answer confidently, and you should say so rather than filling the gap yourself.',
  input,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language memory question" },
      limit: { type: "integer", description: "Max nodes to return", minimum: 1 },
    },
    required: ["query"],
  },
  async handler(ctx, parsed) {
    return yaadToolCall(
      () =>
        ctx.yaad.recall({
          query: parsed.query,
          ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        }),
      (response) => ({
        nodes: response.nodes.map((node) => ({
          id: node.id,
          kind: node.kind,
          title: node.title,
          body: node.body,
          occurred_at: node.occurred_at,
          expires_at: node.expires_at,
          detail: node.detail,
        })),
        edges: response.edges.map((edge) => ({
          src_id: edge.src_id,
          dst_id: edge.dst_id,
          type: edge.type,
        })),
        sufficient: response.sufficient,
        coverage: response.coverage,
      }),
    );
  },
});
