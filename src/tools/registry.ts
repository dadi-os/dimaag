import type { ToolDefinition } from "./types.js";

/**
 * Every non-embedded tool. Embedded lane plumbing (send_message, dispatch_message,
 * steer_reasoning) is deliberately NOT here — those are not grantable and never
 * appear in the tools table.
 */
const definitions: ToolDefinition<never>[] = [];

const byName = new Map<string, ToolDefinition<never>>();
for (const definition of definitions) {
  if (byName.has(definition.name)) {
    throw new Error(`duplicate tool name in registry: ${definition.name}`);
  }
  byName.set(definition.name, definition);
}

export function allTools(): ToolDefinition<never>[] {
  return definitions;
}

export function findTool(name: string): ToolDefinition<never> | undefined {
  return byName.get(name);
}
