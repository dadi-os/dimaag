import { createHash } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentTools, tools } from "../db/schema.js";
import { allTools } from "./registry.js";

/**
 * Old name → new name. Grants move to the new toolId before prune, because
 * toolId is hashed from the name and a hard-cut would drop the grant.
 */
const TOOL_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["chaavi_use_passkey", "chaavi_fill_passkey"],
  ["chaavi_with_secret", "chaavi_fill_secret"],
];

/**
 * Deterministic id from a tool name, so ids are stable across environments and
 * fresh databases without hand-maintained UUID constants.
 */
export function toolId(name: string): string {
  const hash = createHash("sha1").update(`dimaag.tool.${name}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join("-");
}

/**
 * Upsert one row per registered tool, prune grants and tool rows that are no
 * longer in the registry (hard-cut renames), then fail if anything is still orphaned.
 */
export async function syncTools(db: Db): Promise<void> {
  const definitions = allTools();
  const knownIds = definitions.map((definition) => toolId(definition.name));

  for (const definition of definitions) {
    const id = toolId(definition.name);
    await db
      .insert(tools)
      .values({
        id,
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      })
      .onConflictDoUpdate({
        target: tools.id,
        set: {
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
        },
      });
  }

  await remapRenamedGrants(db);

  if (knownIds.length === 0) {
    await db.delete(agentTools);
    await db.delete(tools);
    return;
  }

  await db.delete(agentTools).where(notInArray(agentTools.toolId, knownIds));
  await db.delete(tools).where(notInArray(tools.id, knownIds));

  const orphaned = await db
    .select({ toolId: agentTools.toolId, agentId: agentTools.agentId })
    .from(agentTools)
    .where(notInArray(agentTools.toolId, knownIds));

  if (orphaned.length > 0) {
    const detail = orphaned
      .map((row) => `agent ${row.agentId} -> tool ${row.toolId}`)
      .join(", ");
    throw new Error(
      `agent_tools references tools not in the registry after prune: ${detail}`,
    );
  }
}

/**
 * remapRenamedGrants copies each grant from the old toolId onto the new one
 * (keeping usage), then deletes the old grant. Skips the copy when the agent
 * already holds the new tool.
 */
async function remapRenamedGrants(db: Db): Promise<void> {
  for (const [fromName, toName] of TOOL_RENAMES) {
    const fromId = toolId(fromName);
    const toId = toolId(toName);
    const grants = await db.select().from(agentTools).where(eq(agentTools.toolId, fromId));
    for (const grant of grants) {
      const existing = await db
        .select({ agentId: agentTools.agentId })
        .from(agentTools)
        .where(and(eq(agentTools.agentId, grant.agentId), eq(agentTools.toolId, toId)));
      if (existing.length === 0) {
        await db.insert(agentTools).values({
          agentId: grant.agentId,
          toolId: toId,
          usage: grant.usage,
        });
      }
    }
    await db.delete(agentTools).where(eq(agentTools.toolId, fromId));
  }
}
