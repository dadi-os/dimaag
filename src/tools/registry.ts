import type { ToolDefinition } from "./types.js";
import { spawnAgent } from "./dimaag/spawn-agent.js";
import { modifyAgent } from "./dimaag/modify-agent.js";
import { grantTool } from "./dimaag/grant-tool.js";
import { revokeTool } from "./dimaag/revoke-tool.js";
import { listDevices } from "./ghar/list-devices.js";
import { getState } from "./ghar/get-state.js";
import { controlDevice } from "./ghar/control-device.js";
import { getDeviceEvents } from "./ghar/get-device-events.js";
import { recall } from "./yaad/recall.js";
import { query } from "./yaad/query.js";
import { getNode } from "./yaad/get-node.js";
import { ingest } from "./yaad/ingest.js";

/**
 * Every non-embedded tool. Embedded lane plumbing (send_message, dispatch_message,
 * route_message, steer_reasoning, yield) is deliberately NOT here — those are not
 * grantable and never appear in the tools table.
 */
const definitions = [
  spawnAgent,
  modifyAgent,
  grantTool,
  revokeTool,
  recall,
  query,
  getNode,
  ingest,
  listDevices,
  getState,
  controlDevice,
  getDeviceEvents,
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
