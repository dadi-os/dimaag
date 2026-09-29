/**
 * Embedded `modify_agent`: every agent can rewrite its own purpose or go dormant,
 * and manage its direct children the same way. Not grantable, and not the
 * router's — the router hands work off; agents reshape themselves.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { agents } from "../db/schema.js";
import { agentIdSchema } from "../agent-id.js";
import {
  fail,
  failWithoutAgentIdentity,
  ok,
  requireAgent,
  type ToolContext,
  type ToolExecResult,
} from "../tools/shared.js";
import type { DwarTool } from "../types/domain.js";
import { MODIFY_AGENT } from "../types/domain.js";

const modifyAgentInput = z
  .object({
    agent_id: agentIdSchema,
    system_prompt: z.string().min(1).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.system_prompt !== undefined || value.active !== undefined, {
    message: "system_prompt or active is required",
  });

/** Change the caller's or a direct child's system prompt or active flag. */
export const modifyAgentTool: DwarTool = {
  name: MODIFY_AGENT,
  description:
    "Change your own system prompt or active flag, or a direct child's. Use it when your job itself changes — you are told to take on new responsibilities, organize differently, or stop doing something — so the change outlives this wake. The new system_prompt replaces the old one whole, so carry forward everything that still holds. active false puts an agent dormant. Ids are immutable and cannot be renamed.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      agent_id: {
        type: "string",
        description: "Your own id or a direct child's; immutable kebab-case",
      },
      system_prompt: { type: "string", description: "The full replacement prompt" },
      active: { type: "boolean" },
    },
    required: ["agent_id"],
  },
};

/** runModifyAgent applies modify_agent for an agent caller, limited to itself and its direct children. */
export async function runModifyAgent(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const parsed = modifyAgentInput.parse(raw);
  const target = await requireAgent(ctx.db, parsed.agent_id);
  if (target.id !== ctx.callerId && target.parentAgentId !== ctx.callerId) {
    return fail("modify_agent is limited to yourself or your direct children");
  }

  const oldPrompt = target.systemPrompt;
  const newPrompt = parsed.system_prompt ?? oldPrompt;
  const active = parsed.active ?? target.active;
  const now = new Date();
  await ctx.db
    .update(agents)
    .set({ systemPrompt: newPrompt, active, updatedAt: now })
    .where(eq(agents.id, target.id));

  ctx.events.emit({
    type: "agent_modified",
    agent_id: target.id,
    name: target.id,
    active,
    at: now.toISOString(),
  });

  return ok(
    { agent_id: target.id, old_system_prompt: oldPrompt, active },
    { old_system_prompt: oldPrompt, new_system_prompt: newPrompt },
  );
}
