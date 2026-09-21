import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { agentTools, tools } from "../../db/schema.js";
import { defineTool } from "../types.js";
import { ok, fail, requireAgent } from "../shared.js";

const input = z.object({
  agent_id: z.string().uuid(),
});

/** Read name, system prompt, parent, active flag, and tool names for self or a direct child (any agent as Dadi). */
export const getAgent = defineTool({
  name: "dimaag_get_agent",
  description:
    "Read an agent's name, system prompt, parent, active flag, and the names of the tools it holds. Only the caller or its direct children are allowed. As Dadi, any agent is allowed.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "Self or a direct child (any agent as Dadi)" },
    },
    required: ["agent_id"],
  },
  async handler(ctx, parsed) {
    const target = await requireAgent(ctx.db, parsed.agent_id);
    if (
      ctx.callerId !== null &&
      target.id !== ctx.callerId &&
      target.parentAgentId !== ctx.callerId
    ) {
      return fail("get_agent is limited to self or direct children");
    }

    const held = await ctx.db
      .select({ name: tools.name })
      .from(agentTools)
      .innerJoin(tools, eq(agentTools.toolId, tools.id))
      .where(eq(agentTools.agentId, target.id))
      .orderBy(asc(tools.name));

    return ok({
      name: target.name,
      system_prompt: target.systemPrompt,
      parent_agent_id: target.parentAgentId,
      active: target.active,
      tools: held.map((row) => row.name),
    });
  },
});
