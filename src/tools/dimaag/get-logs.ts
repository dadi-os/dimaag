import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { agentLogs } from "../../db/schema.js";
import { toLogRecord } from "../../serialize.js";
import { requireAgent } from "../shared.js";
import { defineTool } from "../types.js";
import { ok } from "../shared.js";

const input = z
  .object({
    agent_id: z.string().uuid().optional(),
    event: z.enum(["thought", "tool_call", "tool_result", "message"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

/** Query durable agent audit logs (thought / tool_call / tool_result / message). */
export const getLogs = defineTool({
  name: "dimaag_get_logs",
  description:
    "Read agent cognition audit logs from Dimaag (thoughts, tool calls, tool results, messages). Optional agent_id scopes to one agent. Not system HTTP logs — use nas_get_logs for those.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", format: "uuid" },
      event: {
        type: "string",
        enum: ["thought", "tool_call", "tool_result", "message"],
      },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: [],
  },
  async handler(ctx, parsed) {
    const limit = parsed.limit ?? 50;
    if (parsed.agent_id) {
      await requireAgent(ctx.db, parsed.agent_id);
    }
    const rows = await ctx.db
      .select()
      .from(agentLogs)
      .where(
        parsed.agent_id && parsed.event
          ? and(
              eq(agentLogs.agentId, parsed.agent_id),
              eq(agentLogs.event, parsed.event),
            )
          : parsed.agent_id
            ? eq(agentLogs.agentId, parsed.agent_id)
            : parsed.event
              ? eq(agentLogs.event, parsed.event)
              : undefined,
      )
      .orderBy(desc(agentLogs.createdAt))
      .limit(limit);
    return ok({ logs: rows.map(toLogRecord) });
  },
});
