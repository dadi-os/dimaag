import { z } from "zod";
import { defineTool } from "../types.js";
import { yaadToolCall } from "./call.js";

const input = z
  .object({
    text: z.string().min(1),
    participant_ids: z.array(z.string().uuid()).optional(),
  })
  .strict();

/** Store a fact/event via Yaad `/ingest` (source always `agent`). */
export const ingest = defineTool({
  name: "ingest",
  description:
    "Store something in memory. Pass the fact or event as plain text — Yaad extracts the people, places, plans, and relationships itself, and reconciles them against what is already stored rather than creating duplicates. Use participant_ids when you already know the node ids of people involved (from a prior recall or query) so the extraction pins to those exact people instead of matching by name.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", description: "Fact or event to store, in plain language" },
      participant_ids: {
        type: "array",
        items: { type: "string" },
        description: "Known person node ids to pin extraction to",
      },
    },
    required: ["text"],
  },
  async handler(ctx, parsed) {
    return yaadToolCall(
      () =>
        ctx.yaad.ingest({
          text: parsed.text,
          occurred_at: new Date().toISOString(),
          source: "agent",
          ...(parsed.participant_ids !== undefined
            ? { participant_ids: parsed.participant_ids }
            : {}),
        }),
      (response) => ({
        counts: response.counts,
        operations: response.operations,
      }),
    );
  },
});
