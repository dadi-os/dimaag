import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { agentLogs } from "../../db/schema.js";
import { toLogRecord } from "../../serialize.js";
import { defineTool } from "../types.js";
import { ok, fail, requireAgent } from "../shared.js";

const input = z
  .object({
    agent_id: agentIdSchema.optional(),
    event: z.enum(["response", "tool_result", "message"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

/**
 * Query durable audit logs. Agents read themselves or a direct child. The router
 * (and the user) read any agent; with no agent_id they read the null identity —
 * the router's own turns and every message Ankur or the router sent or received.
 */
export const getLogs = defineTool({
  name: "get_logs",
  description:
    "Read cognition audit logs for yourself or a direct child: response rows hold one model turn in order (thinking, text, tool calls), tool_result rows hold each tool's name and outcome, message rows hold delivered messages. Defaults to yourself when agent_id is omitted. The router may read any agent, and by default reads its own null identity: its turns plus every message sent by or to Ankur. Not system HTTP logs — use nas_get_logs for those.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "Self or a direct child (any agent for the router); defaults to yourself",
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
    const targetId = parsed.agent_id ?? ctx.callerId;
    if (targetId !== null) {
      const target = await requireAgent(ctx.db, targetId);
      if (
        ctx.callerId !== null &&
        target.id !== ctx.callerId &&
        target.parentAgentId !== ctx.callerId
      ) {
        return fail("get_logs is limited to self or direct children");
      }
    }
    const party: SQL =
      targetId === null ? isNull(agentLogs.agentId) : eq(agentLogs.agentId, targetId);
    const limit = parsed.limit ?? 50;
    const rows = await ctx.db
      .select()
      .from(agentLogs)
      .where(parsed.event ? and(party, eq(agentLogs.event, parsed.event)) : party)
      .orderBy(desc(agentLogs.createdAt))
      .limit(limit);
    return ok({ logs: rows.map(toLogRecord) });
  },
});
