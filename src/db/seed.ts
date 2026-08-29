import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { ROOT_DADI_ID, SPAWN_AGENT, MODIFY_AGENT } from "../types/domain.js";
import type { Db } from "./client.js";
import { agentTools, agents, tools } from "./schema.js";
import { spawnAgentInputSchema, modifyAgentInputSchema } from "../runtime/tools.js";

const SPAWN_AGENT_ID = "00000000-0000-4000-8000-000000000010";
const MODIFY_AGENT_ID = "00000000-0000-4000-8000-000000000011";

/**
 * Idempotent root-Dadi insert. After this runs, Dadi is an ordinary row.
 */
export async function seedRootDadi(db: Db, serviceRoot: string): Promise<void> {
  const systemPrompt = readFileSync(join(serviceRoot, "prompts/dadi.md"), "utf8");
  await db
    .insert(agents)
    .values({
      id: ROOT_DADI_ID,
      name: "Dadi",
      systemPrompt,
      parentAgentId: null,
      active: true,
    })
    .onConflictDoNothing({ target: agents.id });
}

/**
 * Platform registry tools for this pass. Prompt 2 replaces this whole function.
 */
export async function seedPlatformTools(db: Db): Promise<void> {
  await db
    .insert(tools)
    .values([
      {
        id: SPAWN_AGENT_ID,
        name: SPAWN_AGENT,
        description:
          "Create a child agent. The new agent has the caller as its parent. Omit system_prompt to copy the caller's current prompt.",
        inputSchema: spawnAgentInputSchema,
      },
      {
        id: MODIFY_AGENT_ID,
        name: MODIFY_AGENT,
        description:
          "Change an agent's system prompt or active flag. Only the caller or its direct children are allowed. Enforced in code.",
        inputSchema: modifyAgentInputSchema,
      },
    ])
    .onConflictDoNothing({ target: tools.id });

  await db
    .insert(agentTools)
    .values([
      {
        agentId: ROOT_DADI_ID,
        toolId: SPAWN_AGENT_ID,
        usage:
          "Spawn a domain agent or a worker when a job needs its own prompt and tools. Name it plainly. Give it a narrower prompt than yours.",
      },
      {
        agentId: ROOT_DADI_ID,
        toolId: MODIFY_AGENT_ID,
        usage:
          "Update your own prompt or a direct child's. Set active to false to stop a child you spawned. You cannot reach their children.",
      },
    ])
    .onConflictDoNothing({ target: [agentTools.agentId, agentTools.toolId] });
}

export async function seed(db: Db, config: Config): Promise<void> {
  await seedRootDadi(db, config.serviceRoot);
  await seedPlatformTools(db);
}
