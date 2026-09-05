import { z } from "zod";
import { agentTools } from "../../db/schema.js";
import { defineTool } from "../types.js";
import { findTool } from "../registry.js";
import { toolId } from "../sync.js";
import { ok, fail, requireAgent } from "../shared.js";

const input = z.object({
  agent_id: z.string().uuid(),
  tool_name: z.string().min(1),
  usage: z.string().min(1),
});

export const grantTool = defineTool({
  name: "grant_tool",
  description:
    "Give one of your direct children a tool. usage explains when and why that specific agent should reach for it, which the child sees alongside the tool's own description.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "A direct child of yours" },
      tool_name: { type: "string", description: "Registry tool name" },
      usage: {
        type: "string",
        description: "When and why this agent should use this tool",
      },
    },
    required: ["agent_id", "tool_name", "usage"],
  },
  async handler(ctx, parsed) {
    const target = await requireAgent(ctx.db, parsed.agent_id);
    if (target.parentAgentId !== ctx.callerId) {
      return fail("grant_tool is limited to your direct children");
    }
    if (!findTool(parsed.tool_name)) {
      return fail(`no tool named ${parsed.tool_name}`);
    }
    await ctx.db
      .insert(agentTools)
      .values({
        agentId: parsed.agent_id,
        toolId: toolId(parsed.tool_name),
        usage: parsed.usage,
      })
      .onConflictDoUpdate({
        target: [agentTools.agentId, agentTools.toolId],
        set: { usage: parsed.usage },
      });
    return ok({ agent_id: parsed.agent_id, tool_name: parsed.tool_name });
  },
});
