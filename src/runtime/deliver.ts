import type { Db } from "../db/client.js";
import { writeAgentLog } from "../db/logs.js";
import type { EventBus } from "./events.js";
import type { TranscriptEntry, TranscriptStore } from "./transcript.js";

/**
 * Persist a human → agent message (from_agent_id null) and wake the recipient's
 * conversation lane. Shared by POST /messages and root's route_message tool.
 */
export async function deliverUserMessage(
  deps: {
    db: Db;
    transcript: TranscriptStore;
    events: EventBus;
    enqueueConversation: (agentId: string) => void;
  },
  toAgentId: string,
  content: string,
): Promise<TranscriptEntry> {
  const row = deps.transcript.append({
    fromAgentId: null,
    toAgentId,
    content,
  });
  await writeAgentLog(deps.db, {
    agentId: toAgentId,
    lane: "conversation",
    event: "message",
    payload: {
      direction: "receive",
      message_id: null,
      from_agent_id: null,
      to_agent_id: row.toAgentId,
      content: row.content,
      seq: row.seq,
    },
  });
  deps.events.emit({
    type: "message",
    agent_id: toAgentId,
    from_agent_id: null,
    to_agent_id: row.toAgentId,
    content: row.content,
    seq: row.seq,
    at: row.createdAt.toISOString(),
  });
  deps.enqueueConversation(toAgentId);
  return row;
}
