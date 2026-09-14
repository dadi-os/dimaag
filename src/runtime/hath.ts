/**
 * In-process Hath reverse-RPC: emit commands on the event bus and wait for
 * a matching POST /hath/commands/:id/result from the target client.
 */

import { randomUUID } from "node:crypto";
import type { EventBus } from "./events.js";

/** Tool names Hath clients know how to execute locally. */
export type HathToolName =
  | "hath_get_info"
  | "hath_get_battery"
  | "hath_get_location"
  | "hath_get_network"
  | "hath_read_clipboard"
  | "hath_write_clipboard"
  | "hath_send_file";

export type HathPresence = {
  node_name: string;
  platform: string;
  app_version: string;
  at: string;
};

export type HathCommandResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { type: string; message: string } };

type Pending = {
  resolve: (result: HathCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Track live Hath app heartbeats and outstanding command promises. */
export class HathGateway {
  private readonly presence = new Map<string, HathPresence>();
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly events: EventBus,
    private readonly timeoutMs: number,
  ) {}

  /** Record a heartbeat from a Hath client. */
  setPresence(body: { node_name: string; platform: string; app_version: string }): HathPresence {
    const entry: HathPresence = {
      node_name: body.node_name,
      platform: body.platform,
      app_version: body.app_version,
      at: new Date().toISOString(),
    };
    this.presence.set(body.node_name, entry);
    return entry;
  }

  /** Latest heartbeat for a node, if any. */
  getPresence(nodeName: string): HathPresence | undefined {
    return this.presence.get(nodeName);
  }

  /** All known heartbeats (may include offline-but-recent clients). */
  listPresence(): HathPresence[] {
    return [...this.presence.values()];
  }

  /**
   * Emit a hath_command SSE event and wait for the client result or timeout.
   */
  dispatch(
    nodeName: string,
    tool: HathToolName,
    args: Record<string, unknown>,
  ): Promise<HathCommandResult> {
    const commandId = randomUUID();
    return new Promise<HathCommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        resolve({
          ok: false,
          error: {
            type: "upstream_timeout",
            message: `Hath client ${nodeName} did not respond to ${tool} within ${this.timeoutMs}ms`,
          },
        });
      }, this.timeoutMs);
      this.pending.set(commandId, { resolve, timer });
      this.events.emit({
        type: "hath_command",
        command_id: commandId,
        node_name: nodeName,
        tool,
        args,
        at: new Date().toISOString(),
      });
    });
  }

  /** Complete a pending command from POST /hath/commands/:id/result. */
  complete(commandId: string, result: HathCommandResult): boolean {
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
