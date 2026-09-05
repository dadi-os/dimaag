import { createHash } from "node:crypto";
import { notInArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentTools, tools } from "../db/schema.js";
import { allTools } from "./registry.js";

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
 * Upsert one row per registered tool, then fail loudly if any existing grant
 * points at a tool the registry no longer defines.
 */
export async function syncTools(db: Db): Promise<void> {
  const definitions = allTools();

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

  const knownIds = definitions.map((definition) => toolId(definition.name));
  const orphaned =
    knownIds.length === 0
      ? await db.select({ toolId: agentTools.toolId, agentId: agentTools.agentId }).from(agentTools)
      : await db
          .select({ toolId: agentTools.toolId, agentId: agentTools.agentId })
          .from(agentTools)
          .where(notInArray(agentTools.toolId, knownIds));

  if (orphaned.length > 0) {
    const detail = orphaned
      .map((row) => `agent ${row.agentId} -> tool ${row.toolId}`)
      .join(", ");
    throw new Error(
      `agent_tools references tools not in the registry: ${detail}. ` +
        `A grant pointing at a removed tool silently strips an agent's capability — ` +
        `remove the grant explicitly or restore the tool definition.`,
    );
  }
}
