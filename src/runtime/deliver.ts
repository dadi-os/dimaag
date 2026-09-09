import type { Db } from "../db/client.js";
import { writeAgentLog } from "../db/logs.js";
import type { EventBus } from "./events.js";
import type { TranscriptEntry, TranscriptStore } from "./transcript.js";

type DeliverDeps = {
  db: Db;
  transcript: TranscriptStore;
  events: EventBus;
  enqueueConversation: (agentId: string) => void;
};

/**
 * Persist a human → agent message (from_agent_id null) and wake the recipient's
 * conversation lane. Shared by POST /messages and root's route_message tool.
 */
export async function deliverUserMessage(
  deps: DeliverDeps,
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

/**
 * Persist an agent → agent|user message. Shared by dispatch_message and the
 * scheduled-message ticker. Caller checks agent existence/active before calling.
 */
export async function deliverAgentMessage(
  deps: DeliverDeps,
  args: {
    fromAgentId: string;
    toAgentId: string | null;
    content: string;
    extraPayload?: Record<string, unknown>;
  },
): Promise<TranscriptEntry> {
  const extra = args.extraPayload ?? {};
  const row = deps.transcript.append({
    fromAgentId: args.fromAgentId,
    toAgentId: args.toAgentId,
    content: args.content,
  });
  await writeAgentLog(deps.db, {
    agentId: args.fromAgentId,
    lane: "conversation",
    event: "message",
    payload: {
      direction: "send",
      message_id: null,
      from_agent_id: args.fromAgentId,
      to_agent_id: row.toAgentId,
      content: row.content,
      seq: row.seq,
      ...extra,
    },
  });
  if (row.toAgentId !== null) {
    await writeAgentLog(deps.db, {
      agentId: row.toAgentId,
      lane: "conversation",
      event: "message",
      payload: {
        direction: "receive",
        message_id: null,
        from_agent_id: args.fromAgentId,
        to_agent_id: row.toAgentId,
        content: row.content,
        seq: row.seq,
        ...extra,
      },
    });
    deps.enqueueConversation(row.toAgentId);
  }
  deps.events.emit({
    type: "message",
    agent_id: row.toAgentId ?? args.fromAgentId,
    from_agent_id: args.fromAgentId,
    to_agent_id: row.toAgentId,
    content: row.content,
    seq: row.seq,
    at: row.createdAt.toISOString(),
  });
  return row;
}
