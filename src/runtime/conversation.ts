import type { DwarChatRequest, DwarChatResponse, DwarMessage, DwarToolUseBlock } from "../types/domain.js";
import { YIELD } from "../types/domain.js";
import type { IntentQueue } from "./intents.js";
import { formatIntentTurn } from "./intents.js";
import type { ToolExecResult } from "./tools.js";

export type ConversationLoopDeps = {
  agentId: string;
  scratchpad: DwarMessage[];
  assemble: () => Promise<DwarChatRequest>;
  converse: (request: DwarChatRequest) => Promise<DwarChatResponse>;
  executeTool: (call: DwarToolUseBlock) => Promise<ToolExecResult>;
  intents: IntentQueue;
  logThought: (response: DwarChatResponse) => Promise<void>;
  logToolCall: (call: DwarToolUseBlock, result: ToolExecResult) => Promise<void>;
  logToolResult: (toolUseId: string, result: ToolExecResult) => Promise<void>;
};

/**
 * Conversation-lane tool loop. Dwar forces tool use; text may accompany tools as
 * narration. The only clean exit is the embedded yield tool. A bare response with
 * no tools is treated as a degraded exit (provider failure), not the happy path.
 * Scratchpad holds mid-turn tool results only — cleared when the turn ends so
 * prior yields cannot few-shot the next wake.
 */
export async function runConversationLoop(deps: ConversationLoopDeps): Promise<void> {
  const scratchpad = deps.scratchpad;

  for (;;) {
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

    const uses = response.content.filter(
      (block): block is DwarToolUseBlock => block.type === "tool_use",
    );
    if (uses.length === 0) {
      scratchpad.length = 0;
      return;
    }

    scratchpad.push({ role: "assistant", content: response.content });
    const results = [];
    let yielded = false;
    for (const call of uses) {
      if (call.name === YIELD) {
        yielded = true;
      }
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
    if (yielded) {
      scratchpad.length = 0;
      return;
    }
  }
}
