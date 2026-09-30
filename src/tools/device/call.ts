import type { DeviceToolName } from "../../runtime/devices.js";
import type { ToolExecResult } from "../shared.js";
import { ok } from "../shared.js";
import type { ToolContext } from "../shared.js";

/**
 * Dispatch a device_* command to a live client and map failures to tool errors.
 */
export async function deviceToolCall(
  ctx: ToolContext,
  nodeName: string,
  tool: DeviceToolName,
  args: Record<string, unknown> = {},
): Promise<ToolExecResult> {
  const outcome = await ctx.devices.dispatch(nodeName, tool, args);
  if (outcome.ok) {
    return ok(outcome.result, { node_name: nodeName, tool });
  }
  return {
    content: `${outcome.error.type}: ${outcome.error.message}`,
    isError: true,
    audit: { node_name: nodeName, tool },
  };
}
