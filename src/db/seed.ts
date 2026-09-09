import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { ROOT_DADI_ID } from "../types/domain.js";
import { toolId } from "../tools/sync.js";
import type { Db } from "./client.js";
import { agentTools, agents } from "./schema.js";

/**
 * Idempotent root-Dadi upsert. Prompt tracks prompts/dadi.md on every migrate
 * and every process boot (index calls migrate), so editing the file + tsx restart
 * keeps routing instructions current; other columns are left alone.
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
    .onConflictDoUpdate({
      target: agents.id,
      set: { systemPrompt },
    });
}

const DADI_GRANTS: Array<{ tool: string; usage: string }> = [
  {
    tool: "spawn_agent",
    usage:
      "When no existing child owns this exact user problem, spawn a thread with a narrow job prompt. Do not do the user's work yourself — spawn, grant, and hand the UUID back.",
  },
  {
    tool: "modify_agent",
    usage:
      "Update your own prompt or a direct child's. Set active to false to stop a child you spawned.",
  },
  {
    tool: "grant_tool",
    usage:
      "Right after spawning (or when reusing a child that lacks them), grant only the tools that thread needs for the job — e.g. ingest/recall for memory facts.",
  },
  {
    tool: "revoke_tool",
    usage: "Take a tool back from a child when it no longer needs it.",
  },
  {
    tool: "recall",
    usage:
      "For thread agents that need memory. Root reasoning should not use this to answer the user — grant it to the thread instead.",
  },
  {
    tool: "query",
    usage:
      "For thread agents that need exact lookups. Root reasoning should not use this to answer the user — grant it to the thread instead.",
  },
  {
    tool: "get_node",
    usage:
      "For thread agents that need node edges. Root reasoning should not use this to answer the user — grant it to the thread instead.",
  },
  {
    tool: "ingest",
    usage:
      "For thread agents that store facts. Root reasoning must not ingest on the user's behalf — spawn/grant a memory-capable thread and route the message there.",
  },
  {
    tool: "list_devices",
    usage:
      "When the user asks what is in the house, or before you control a device you have not already looked up this turn.",
  },
  {
    tool: "get_state",
    usage:
      "When the question is about how long something has held its current value — empty rooms, lights left on — not when they want a history of changes.",
  },
  {
    tool: "control_device",
    usage:
      "When the user asks you to change a light, switch, or other device. Confirm the device id and capability from list_devices first if you do not already have them.",
  },
  {
    tool: "get_device_events",
    usage:
      "When the user asks what happened to a device or why it changed — use cause to separate your earlier actions from someone flipping the wall switch.",
  },
];

export async function seed(db: Db, config: Config): Promise<void> {
  await seedRootDadi(db, config.serviceRoot);
  for (const grant of DADI_GRANTS) {
    await db
      .insert(agentTools)
      .values({
        agentId: ROOT_DADI_ID,
        toolId: toolId(grant.tool),
        usage: grant.usage,
      })
      .onConflictDoUpdate({
        target: [agentTools.agentId, agentTools.toolId],
        set: { usage: grant.usage },
      });
  }
}
