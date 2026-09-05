import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { ROOT_DADI_ID } from "../types/domain.js";
import { toolId } from "../tools/sync.js";
import type { Db } from "./client.js";
import { agentTools, agents } from "./schema.js";

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

const DADI_GRANTS: Array<{ tool: string; usage: string }> = [
  {
    tool: "spawn_agent",
    usage:
      "Spawn a child when a request needs its own prompt and its own tools. Give it a narrower prompt than yours and grant it only what the job needs.",
  },
  {
    tool: "modify_agent",
    usage:
      "Update your own prompt or a direct child's. Set active to false to stop a child you spawned.",
  },
  {
    tool: "grant_tool",
    usage: "Give a child you spawned the tools its job requires, right after spawning it.",
  },
  {
    tool: "revoke_tool",
    usage: "Take a tool back from a child when it no longer needs it.",
  },
];

export async function seed(db: Db, config: Config): Promise<void> {
  await seedRootDadi(db, config.serviceRoot);
  await db
    .insert(agentTools)
    .values(
      DADI_GRANTS.map((grant) => ({
        agentId: ROOT_DADI_ID,
        toolId: toolId(grant.tool),
        usage: grant.usage,
      })),
    )
    .onConflictDoNothing({ target: [agentTools.agentId, agentTools.toolId] });
}
