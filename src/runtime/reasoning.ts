import type { DwarChatRequest, DwarChatResponse, DwarMessage, DwarToolUseBlock } from "../types/domain.js";
import { YIELD } from "../types/domain.js";
import type { SteerQueue } from "./steer.js";
import { formatSteerTurn } from "./steer.js";
import type { ToolExecResult } from "./tools.js";

export type ReasoningLoopDeps = {
  agentId: string;
  scratchpad: DwarMessage[];
  assemble: () => Promise<DwarChatRequest>;
  reason: (request: DwarChatRequest) => Promise<DwarChatResponse>;
  executeTool: (call: DwarToolUseBlock) => Promise<ToolExecResult>;
  steer: SteerQueue;
  logThought: (response: DwarChatResponse) => Promise<void>;
  logToolCall: (call: DwarToolUseBlock, result: ToolExecResult) => Promise<void>;
  logToolResult: (toolUseId: string, result: ToolExecResult) => Promise<void>;
};

/**
 * Reasoning-lane scratchpad loop. Dwar forces tool use; text may accompany tools as
 * internal working output. The only clean exit is the embedded yield tool. A bare
 * response with no tools is a degraded exit; pending steers still continue the loop.
 * Scratchpad holds mid-turn tool results only — cleared when the turn ends so
 * prior yields cannot few-shot the next wake.
 */
export async function runReasoningLoop(deps: ReasoningLoopDeps): Promise<void> {
  const scratchpad = deps.scratchpad;

  for (;;) {
    const assembled = await deps.assemble();
    const messages: DwarMessage[] = [...assembled.messages, ...scratchpad];
    const steers = deps.steer.drain(deps.agentId);
    if (steers.length > 0) {
      messages.push({ role: "user", content: formatSteerTurn(steers) });
    }

    const response = await deps.reason({
      system: assembled.system,
      messages,
      tools: assembled.tools,
    });
    await deps.logThought(response);

    const uses = response.content.filter(
      (block): block is DwarToolUseBlock => block.type === "tool_use",
    );
    if (uses.length === 0) {
      scratchpad.push({ role: "assistant", content: response.content });
      if (deps.steer.hasItems(deps.agentId)) {
        continue;
      }
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
