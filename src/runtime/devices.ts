/**
 * In-process device reverse-RPC: emit commands on the event bus and wait for
 * a matching POST /devices/commands/:id/result from the target client.
 */

import { randomUUID } from "node:crypto";
import type { EventBus } from "./events.js";

/** Tool names device apps know how to execute locally. */
export type DeviceToolName =
  | "device_get_info"
  | "device_get_battery"
  | "device_get_location"
  | "device_get_network"
  | "device_read_clipboard"
  | "device_write_clipboard"
  | "device_send_file"
  | "device_open_chat";

export type DevicePresence = {
  node_name: string;
  platform: string;
  app_version: string;
  at: string;
};

export type DeviceCommandResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { type: string; message: string } };

type Pending = {
  resolve: (result: DeviceCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Track live device heartbeats and outstanding command promises. */
export class DeviceGateway {
  private readonly presence = new Map<string, DevicePresence>();
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly events: EventBus,
    private readonly timeoutMs: number,
  ) {}

  /** Record a heartbeat from a device. */
  setPresence(body: { node_name: string; platform: string; app_version: string }): DevicePresence {
    const entry: DevicePresence = {
      node_name: body.node_name,
      platform: body.platform,
      app_version: body.app_version,
      at: new Date().toISOString(),
    };
    this.presence.set(body.node_name, entry);
    return entry;
  }

  /** Latest heartbeat for a node, if any. */
  getPresence(nodeName: string): DevicePresence | undefined {
    return this.presence.get(nodeName);
  }

  /** All known heartbeats (may include offline-but-recent clients). */
  listPresence(): DevicePresence[] {
    return [...this.presence.values()];
  }

  /**
   * Emit a device_command SSE event and wait for the client result or timeout.
   */
  dispatch(
    nodeName: string,
    tool: DeviceToolName,
    args: Record<string, unknown>,
  ): Promise<DeviceCommandResult> {
    const commandId = randomUUID();
    return new Promise<DeviceCommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        resolve({
          ok: false,
          error: {
            type: "upstream_timeout",
            message: `Device ${nodeName} did not respond to ${tool} within ${this.timeoutMs}ms`,
          },
        });
      }, this.timeoutMs);
      this.pending.set(commandId, { resolve, timer });
      this.events.emit({
        type: "device_command",
        command_id: commandId,
        node_name: nodeName,
        tool,
        args,
        at: new Date().toISOString(),
      });
    });
  }

  /** Complete a pending command from POST /devices/commands/:id/result. */
  complete(commandId: string, result: DeviceCommandResult): boolean {
    const entry = this.pending.get(commandId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
    entry.resolve(result);
    return true;
  }
}
