import type { ToolDefinition } from "./types.js";
import { spawnAgent } from "./dimaag/spawn-agent.js";
import { modifyAgent } from "./dimaag/modify-agent.js";
import { grantTool } from "./dimaag/grant-tool.js";
import { revokeTool } from "./dimaag/revoke-tool.js";

/**
 * Every non-embedded tool. Embedded lane plumbing (send_message, dispatch_message,
 * steer_reasoning) is deliberately NOT here — those are not grantable and never
 * appear in the tools table.
 */
const definitions = [
  spawnAgent,
  modifyAgent,
  grantTool,
  revokeTool,
] as unknown as ToolDefinition[];

const byName = new Map<string, ToolDefinition>();
for (const definition of definitions) {
  if (byName.has(definition.name)) {
    throw new Error(`duplicate tool name in registry: ${definition.name}`);
  }
  byName.set(definition.name, definition);
}

export function allTools(): ToolDefinition[] {
  return definitions;
}

export function findTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}
