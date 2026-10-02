import { HathError } from "../../errors.js";
import type { DeviceToolName } from "../../runtime/devices.js";
import type { ToolExecResult } from "../shared.js";
import { ok } from "../shared.js";
import type { ToolContext } from "../shared.js";

/** The box's own mesh node (nas `tailscale-up.sh` fixes its hostname); it never runs the dadi app. */
const BOX_NODE_NAME = "os";

/** One enrolled device's line in a survey. */
type DeviceReport = {
  node_name: string;
  /** On the mesh right now, per Headscale and the box's tailscaled. */
  online: boolean;
  last_seen: string | null;
  /** The dadi app has sent a recent heartbeat, so it can answer commands. */
  app_running: boolean;
  /** The device's answer, when the app is running and answered. */
  result?: unknown;
  /** Why a running app's answer failed (upstream_timeout, permission_denied, …). */
  error?: { type: string; message: string };
};

/**
 * Survey every enrolled device for one device_* reading. Lists mesh clients
 * from Nas, reports each one's mesh and app state, and asks only the devices
 * whose app is running, all at once, so offline devices still show up as offline.
 */
export async function surveyDevices(ctx: ToolContext, tool: DeviceToolName): Promise<ToolExecResult> {
  let clients;
  try {
    ({ clients } = await ctx.nas.listClients());
  } catch (err) {
    if (err instanceof HathError) {
      return { content: `${err.type}: ${err.message}`, isError: true, audit: { tool } };
    }
    throw err;
  }

  const devices = await Promise.all(
    clients
      .filter((client) => client.node_name !== BOX_NODE_NAME)
      .map(async (client): Promise<DeviceReport> => {
        const report: DeviceReport = {
          node_name: client.node_name,
          online: client.online,
          last_seen: client.last_seen,
          app_running: ctx.devices.appRunning(client.node_name),
        };
        if (!report.app_running) {
          return report;
        }
        const outcome = await ctx.devices.dispatch(client.node_name, tool, {});
        return outcome.ok ? { ...report, result: outcome.result } : { ...report, error: outcome.error };
      }),
  );

  return ok({ devices }, { tool });
}
