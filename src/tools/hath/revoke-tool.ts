import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { agentTools } from "../../db/schema.js";
import { defineTool } from "../types.js";
import { findTool } from "../registry.js";
import { toolId } from "../sync.js";
import { ok, fail, requireAgent } from "../shared.js";

const input = z.object({
  agent_id: agentIdSchema,
  tool_name: z.string().min(1),
});

/** Revoke a granted tool from a direct child. Embedded for every agent; the router's children are the roots. */
export const revokeTool = defineTool({
  name: "revoke_tool",
  description:
    "Take a tool back from one of your direct children (the router's direct children are the root agents). Fails if the agent does not hold that tool.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "A direct child of yours" },
      tool_name: { type: "string", description: "Registry tool name to revoke" },
    },
    required: ["agent_id", "tool_name"],
  },
  async handler(ctx, parsed) {
    const target = await requireAgent(ctx.db, parsed.agent_id);
    if (ctx.callerKind !== "user" && target.parentAgentId !== ctx.callerId) {
      return fail("revoke_tool is limited to your direct children");
    }
    if (!findTool(parsed.tool_name)) {
      return fail(`no tool named ${parsed.tool_name}`);
    }
    const deleted = await ctx.db
      .delete(agentTools)
      .where(
        and(
          eq(agentTools.agentId, parsed.agent_id),
          eq(agentTools.toolId, toolId(parsed.tool_name)),
        ),
      )
      .returning();
    if (deleted.length === 0) {
      return fail(`agent ${parsed.agent_id} does not hold ${parsed.tool_name}`);
    }
    return ok({ agent_id: parsed.agent_id, tool_name: parsed.tool_name });
  },
});
