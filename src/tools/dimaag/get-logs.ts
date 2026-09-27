import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { agentLogs } from "../../db/schema.js";
import { toLogRecord } from "../../serialize.js";
import { defineTool } from "../types.js";
import { ok, fail, failWithoutAgentIdentity, requireAgent } from "../shared.js";

const input = z
  .object({
    agent_id: agentIdSchema.optional(),
    event: z.enum(["response", "tool_result", "message"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

/** Query durable agent audit logs for self or a direct child. */
export const getLogs = defineTool({
  name: "dimaag_get_logs",
  description:
    "Read cognition audit logs for yourself or a direct child: response rows hold one model turn in order (thinking, text, tool calls), tool_result rows hold each tool's name and outcome, message rows hold delivered messages. Defaults to the caller when agent_id is omitted. Not system HTTP logs — use nas_get_logs for those.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        format: "uuid",
        description: "Self or a direct child; defaults to the caller",
      },
      event: {
        type: "string",
        enum: ["response", "tool_result", "message"],
      },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: [],
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    const targetId = parsed.agent_id ?? ctx.callerId;
    const target = await requireAgent(ctx.db, targetId);
    if (target.id !== ctx.callerId && target.parentAgentId !== ctx.callerId) {
      return fail("get_logs is limited to self or direct children");
    }
    const limit = parsed.limit ?? 50;
    const rows = await ctx.db
      .select()
      .from(agentLogs)
      .where(
        parsed.event
          ? and(eq(agentLogs.agentId, targetId), eq(agentLogs.event, parsed.event))
          : eq(agentLogs.agentId, targetId),
      )
      .orderBy(desc(agentLogs.createdAt))
      .limit(limit);
    return ok({ logs: rows.map(toLogRecord) });
  },
});
