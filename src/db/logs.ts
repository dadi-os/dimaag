/** Append durable agent log rows (thought, tool_call, tool_result, message). */

import { randomUUID } from "node:crypto";
import type { Db } from "./client.js";
import { agentLogs } from "./schema.js";
import type { Lane, LogEvent } from "../types/domain.js";

export async function writeAgentLog(
  db: Db,
  args: {
    agentId: string;
    lane: Lane;
    event: LogEvent;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(agentLogs).values({
    id: randomUUID(),
    agentId: args.agentId,
    lane: args.lane,
    event: args.event,
    payload: args.payload,
  });
}
