import type { DwarChatRequest, DwarChatResponse, DwarMessage, DwarToolUseBlock } from "../types/domain.js";
import type { IntentQueue } from "./intents.js";
import { formatIntentTurn } from "./intents.js";
import type { ToolExecResult } from "./tools.js";

export type ConversationLoopDeps = {
  agentId: string;
  maxIterations: number;
  assemble: () => Promise<DwarChatRequest>;
  converse: (request: DwarChatRequest) => Promise<DwarChatResponse>;
  executeTool: (call: DwarToolUseBlock) => Promise<ToolExecResult>;
  intents: IntentQueue;
  logThought: (response: DwarChatResponse) => Promise<void>;
  logToolCall: (call: DwarToolUseBlock, result: ToolExecResult) => Promise<void>;
  logToolResult: (toolUseId: string, result: ToolExecResult) => Promise<void>;
  logCapExhausted: () => Promise<void>;
};

/**
 * Conversation-lane tool loop over dispatch_message and steer_reasoning.
 * Scratchpad is local and discarded on return.
 */
export async function runConversationLoop(deps: ConversationLoopDeps): Promise<void> {
  const scratchpad: DwarMessage[] = [];

  for (let i = 0; i < deps.maxIterations; i++) {
    const assembled = await deps.assemble();
    const messages: DwarMessage[] = [...assembled.messages, ...scratchpad];
    const intents = deps.intents.drain(deps.agentId);
    if (intents.length > 0) {
      messages.push({ role: "user", content: formatIntentTurn(intents) });
    }

    const response = await deps.converse({
      system: assembled.system,
      messages,
      tools: assembled.tools,
    });
    await deps.logThought(response);

    const uses = response.content.filter((block) => block.type === "tool_use");
    if (response.stop_reason !== "tool_use" || uses.length === 0) {
      return;
    }

    scratchpad.push({ role: "assistant", content: response.content });
    const results = [];
    for (const call of uses) {
      const result = await deps.executeTool(call);
      await deps.logToolCall(call, result);
      await deps.logToolResult(call.id, result);
      results.push({
        type: "tool_result" as const,
        tool_use_id: call.id,
        content: result.content,
        is_error: result.isError,
      });
    }
    scratchpad.push({ role: "user", content: results });
  }
  await deps.logCapExhausted();
}
