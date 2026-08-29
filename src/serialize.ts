import type { AgentLogRow, AgentRow, MessageRow } from "./db/schema.js";
import type { AgentRecord, LogEvent, LogRecord, Lane, MessageRecord } from "./types/domain.js";
import { DimaagError } from "./errors.js";

function parseLane(value: string): Lane {
  if (value === "reasoning" || value === "conversation") {
    return value;
  }
  throw new DimaagError(500, "internal", `invalid lane in database: ${value}`);
}

function parseLogEvent(value: string): LogEvent {
  if (
    value === "thought" ||
    value === "tool_call" ||
    value === "tool_result" ||
    value === "message"
  ) {
    return value;
  }
  throw new DimaagError(500, "internal", `invalid log event in database: ${value}`);
}

export function toAgentRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    system_prompt: row.systemPrompt,
    parent_agent_id: row.parentAgentId,
    active: row.active,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    to_agent_id: row.toAgentId,
    from_agent_id: row.fromAgentId,
    content: row.content,
    seq: row.seq,
    created_at: row.createdAt.toISOString(),
  };
}

export function toLogRecord(row: AgentLogRow): LogRecord {
  return {
    id: row.id,
    agent_id: row.agentId,
    lane: parseLane(row.lane),
    event: parseLogEvent(row.event),
    payload: row.payload,
    created_at: row.createdAt.toISOString(),
  };
}
