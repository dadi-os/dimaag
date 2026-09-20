import { eq } from "drizzle-orm";
import { z } from "zod";
import { agents } from "../../db/schema.js";
import { defineTool } from "../types.js";
import { ok, fail, requireAgent, isUniqueViolation } from "../shared.js";

const input = z
  .object({
    agent_id: z.string().uuid(),
    name: z.string().min(1).optional(),
    system_prompt: z.string().min(1).optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.system_prompt !== undefined ||
      value.active !== undefined,
    {
      message: "name, system_prompt, or active is required",
    },
  );

/** Update name / system_prompt / active for self or a direct child (any agent as Dadi). */
export const modifyAgent = defineTool({
  name: "dimaag_modify_agent",
  description:
    "Change an agent's name, system prompt, or active flag. Only the caller or its direct children are allowed. As Dadi, any agent is allowed.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "Self or a direct child (any agent as Dadi)" },
      name: { type: "string", description: "Unique agent name" },
      system_prompt: { type: "string" },
      active: { type: "boolean" },
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
      return fail("modify_agent is limited to self or direct children");
    }

    const oldName = target.name;
    const newName = parsed.name ?? oldName;
    const oldPrompt = target.systemPrompt;
    const newPrompt = parsed.system_prompt ?? oldPrompt;
    const active = parsed.active ?? target.active;
    const now = new Date();
    try {
      await ctx.db
        .update(agents)
        .set({
          name: newName,
          systemPrompt: newPrompt,
          active,
          updatedAt: now,
        })
        .where(eq(agents.id, target.id));
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(`an agent named ${newName} already exists`);
      }
      throw err;
    }

    ctx.events.emit({
      type: "agent_modified",
      agent_id: target.id,
      name: newName,
      active,
      at: now.toISOString(),
    });

    return ok(
      {
        agent_id: target.id,
        old_name: oldName,
        new_name: newName,
        old_system_prompt: oldPrompt,
        new_system_prompt: newPrompt,
        active,
      },
      {
        old_name: oldName,
        new_name: newName,
        old_system_prompt: oldPrompt,
        new_system_prompt: newPrompt,
      },
    );
  },
});
