/** Shared tool result helpers and agent lookup used by handlers. */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";
import { DimaagError } from "../errors.js";
import type { Lane } from "../types/domain.js";
import type { EventBus } from "../runtime/events.js";
import type { LaneLocks } from "../runtime/locks.js";
import type { SteerQueue } from "../runtime/steer.js";
import type { IntentQueue } from "../runtime/intents.js";
import type { TranscriptStore } from "../runtime/transcript.js";
import type { BrowserDriver } from "../browser/driver.js";
import type { DwarClient } from "../dwar/client.js";
import type { GharClient } from "../ghar/client.js";
import type { NasClient } from "../nas/client.js";
import type { YaadClient } from "../yaad/client.js";

export type ToolExecResult = {
  content: string;
  isError: boolean;
  /** Extra fields merged into the durable tool_call audit log. */
  audit: Record<string, unknown>;
};

export type ToolContext = {
  db: Db;
  callerId: string;
  lane: Lane;
  yaad: YaadClient;
  ghar: GharClient;
  nas: NasClient;
  dwar: DwarClient;
  browsers: BrowserDriver;
  steer: SteerQueue;
  intents: IntentQueue;
  locks: LaneLocks;
  transcript: TranscriptStore;
  events: EventBus;
  enqueueConversation: (agentId: string) => void;
  enqueueReasoning: (agentId: string) => void;
};

export function fail(message: string): ToolExecResult {
  return { content: message, isError: true, audit: {} };
}

export function ok(value: unknown, audit: Record<string, unknown> = {}): ToolExecResult {
  return { content: JSON.stringify(value), isError: false, audit };
}

/** Load an agent row or throw `404 not_found`. */
export async function requireAgent(db: Db, id: string) {
  const rows = await db.select().from(agents).where(eq(agents.id, id));
  const row = rows[0];
  if (!row) {
    throw new DimaagError(404, "not_found", `agent ${id} not found`);
  }
  return row;
}

/** True when err (or a nested cause) is Postgres unique_violation `23505`. */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let i = 0; i < 4; i++) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code: unknown }).code === "23505"
    ) {
      return true;
    }
    if (typeof current === "object" && current !== null && "cause" in current) {
      current = (current as { cause: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}
