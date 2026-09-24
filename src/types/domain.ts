export type Lane = "reasoning" | "conversation";

export type LogEvent = "thought" | "tool_call" | "tool_result" | "message";

/** Nas browsers/terminals this agent recently drove. Empty after process restart. */
export type AgentSessions = {
  browsers: number[];
  terminals: Array<{ id: string; last_command: string | null }>;
};

export type AgentRecord = {
  id: string;
  name: string;
  system_prompt: string;
  parent_agent_id: string | null;
  active: boolean;
  /** In-memory lane lock ownership. Always false right after a process restart. */
  running: { reasoning: boolean; conversation: boolean };
  /** In-memory host attachments. Always empty right after a process restart. */
  sessions: AgentSessions;
  created_at: string;
  updated_at: string;
};

export type LogRecord = {
  id: string;
  agent_id: string;
  lane: Lane;
  event: LogEvent;
  payload: Record<string, unknown>;
  created_at: string;
};

/** API shape for a scheduled_messages row. Presence of the row is the state. */
export type ScheduledMessageRecord = {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  content: string;
  /** Next fire time (ISO). Ticker cursor — advanced after each fire. */
  run_at: string;
  /** null = one-shot; >= 1 = recurring interval in minutes. */
  interval_minutes: number | null;
  created_at: string;
};

export type DwarTextBlock = {
  type: "text";
  text: string;
};

export type DwarToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  /** Opaque provider state (Gemini thought signatures). Round-trip unchanged. */
  thought_signature?: string;
};

export type DwarToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
};

export type DwarContentBlock = DwarTextBlock | DwarToolUseBlock | DwarToolResultBlock;

export type DwarResponseBlock = DwarTextBlock | DwarToolUseBlock;

export type DwarMessage = {
  role: "user" | "assistant";
  content: string | DwarContentBlock[];
};

export type DwarTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type DwarChatRequest = {
  system: string;
  messages: DwarMessage[];
  tools: DwarTool[];
};

export type DwarChatResponse = {
  content: DwarResponseBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "error";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
};

export const SEND_MESSAGE = "send_message";
export const DISPATCH_MESSAGE = "dispatch_message";
export const STEER_REASONING = "steer_reasoning";
export const YIELD = "yield";
export const WAIT = "wait";
export const LIST_AGENTS = "list_agents";
export const SPAWN_AGENT = "dimaag_spawn_agent";
export const MODIFY_AGENT = "dimaag_modify_agent";
export const GET_AGENT = "dimaag_get_agent";
