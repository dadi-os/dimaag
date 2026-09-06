import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agents } from "../../db/schema.js";
import { defineTool } from "../types.js";
import { ok, fail, requireAgent, isUniqueViolation } from "../shared.js";

const input = z.object({
  name: z.string().min(1),
  system_prompt: z.string().min(1),
});

export const spawnAgent = defineTool({
  name: "spawn_agent",
  description:
    "Create a child agent with the caller as its parent. The child starts with no granted tools — use grant_tool afterward to give it capabilities.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Unique agent name" },
      system_prompt: {
        type: "string",
        description:
          "Prompt for both of the child's lanes. Write one that fits the job you are spawning it for.",
      },
    },
    required: ["name", "system_prompt"],
  },
  async handler(ctx, parsed) {
    await requireAgent(ctx.db, ctx.callerId);
    const id = randomUUID();
    try {
      await ctx.db.insert(agents).values({
        id,
        name: parsed.name,
        systemPrompt: parsed.system_prompt,
        parentAgentId: ctx.callerId,
        active: true,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(`an agent named ${parsed.name} already exists`);
      }
      throw err;
    }
    ctx.events.emit({
      type: "agent_spawned",
      agent_id: id,
      parent_agent_id: ctx.callerId,
      name: parsed.name,
      at: new Date().toISOString(),
    });
    return ok({ agent_id: id, name: parsed.name });
  },
});
