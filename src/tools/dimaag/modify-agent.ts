import { eq } from "drizzle-orm";
import { z } from "zod";
import { agents } from "../../db/schema.js";
import { defineTool } from "../types.js";
import { ok, fail, requireAgent } from "../shared.js";

const input = z
  .object({
    agent_id: z.string().uuid(),
    system_prompt: z.string().min(1).optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => value.system_prompt !== undefined || value.active !== undefined, {
    message: "system_prompt or active is required",
  });

export const modifyAgent = defineTool({
  name: "modify_agent",
  description:
    "Change an agent's system prompt or active flag. Only the caller or its direct children are allowed.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "Self or a direct child" },
      system_prompt: { type: "string" },
      active: { type: "boolean" },
    },
    required: ["agent_id"],
  },
  async handler(ctx, parsed) {
    const target = await requireAgent(ctx.db, parsed.agent_id);
    if (target.id !== ctx.callerId && target.parentAgentId !== ctx.callerId) {
      return fail("modify_agent is limited to self or direct children");
    }

    const oldPrompt = target.systemPrompt;
    const newPrompt = parsed.system_prompt ?? oldPrompt;
    const active = parsed.active ?? target.active;
    const now = new Date();
    await ctx.db
      .update(agents)
      .set({
        systemPrompt: newPrompt,
        active,
        updatedAt: now,
      })
      .where(eq(agents.id, target.id));

    return ok(
      {
        agent_id: target.id,
        old_system_prompt: oldPrompt,
        new_system_prompt: newPrompt,
        active,
      },
      { old_system_prompt: oldPrompt, new_system_prompt: newPrompt },
    );
  },
});
