export type Lane = "reasoning" | "conversation";

export type LogEvent =
  | "thought"
  | "tool_call"
  | "tool_result"
  | "message"
  | "iteration_cap_exhausted";

export type AgentRecord = {
  id: string;
  name: string;
  system_prompt: string;
  parent_agent_id: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type MessageRecord = {
  id: string;
  to_agent_id: string | null;
  from_agent_id: string | null;
  content: string;
  seq: number;
  created_at: string;
};

export type LogRecord = {
  id: string;
  agent_id: string;
  lane: Lane;
  event: LogEvent;
  payload: Record<string, unknown>;
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

/** Well-known id of root Dadi. After seed the row is an ordinary agent. */
export const ROOT_DADI_ID = "00000000-0000-4000-8000-000000000001";

export const SEND_MESSAGE = "send_message";
export const DISPATCH_MESSAGE = "dispatch_message";
export const STEER_REASONING = "steer_reasoning";
export const SPAWN_AGENT = "spawn_agent";
export const MODIFY_AGENT = "modify_agent";
