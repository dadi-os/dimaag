import type { DwarChatRequest, DwarChatResponse, DwarMessage, DwarToolUseBlock } from "../types/domain.js";
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
 * Reasoning-lane scratchpad loop. The scratchpad is passed in by reference and persists
 * across invocations for this agent — it is not reset here. It dies only when the
 * process restarts. No iteration cap: Dwar's own per-call timeout and lane_queue_timeout_ms
 * are the only bounds on a running loop.
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

    const uses = response.content.filter((block) => block.type === "tool_use");
    if (response.stop_reason !== "tool_use" || uses.length === 0) {
      scratchpad.push({ role: "assistant", content: response.content });
      if (deps.steer.hasItems(deps.agentId)) {
        continue;
      }
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
}
