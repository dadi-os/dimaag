import { z } from "zod";
import { defineTool } from "../types.js";
import { yaadToolCall } from "./call.js";

const input = z.object({
  kind: z.enum(["person", "memory", "plan", "place"]).optional(),
  name: z.string().min(1).optional(),
  occurred_from: z.string().datetime({ offset: true }).optional(),
  occurred_to: z.string().datetime({ offset: true }).optional(),
  status: z.enum(["idea", "tentative", "confirmed"]).optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().min(0).optional(),
});

/** Exact/filter memory lookup via Yaad `/query`. */
export const query = defineTool({
  name: "query",
  description:
    'Look up memory by exact criteria. Use this for date ranges ("what\'s on my calendar Tuesday"), exact names ("the person named Marcus"), and filtering by kind or plan status. This is exact matching, not similarity — for fuzzy questions use recall instead. At least one filter is required. Events spanning multiple days are returned for any date they overlap, so a trip from the 3rd to the 8th appears when you ask about the 5th.',
  input,
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["person", "memory", "plan", "place"] },
      name: { type: "string", description: "Exact title or person alias" },
      occurred_from: { type: "string", description: "ISO-8601 range start" },
      occurred_to: { type: "string", description: "ISO-8601 range end" },
      status: { type: "string", enum: ["idea", "tentative", "confirmed"] },
      limit: { type: "integer", minimum: 1 },
      offset: { type: "integer", minimum: 0 },
    },
  },
  async handler(ctx, parsed) {
    const body = {
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.occurred_from !== undefined ? { occurred_from: parsed.occurred_from } : {}),
      ...(parsed.occurred_to !== undefined ? { occurred_to: parsed.occurred_to } : {}),
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      ...(parsed.offset !== undefined ? { offset: parsed.offset } : {}),
    };
    return yaadToolCall(
      () => ctx.yaad.query(body),
      (response) => ({
        nodes: response.nodes,
        limit: response.limit,
        offset: response.offset,
      }),
    );
  },
});
