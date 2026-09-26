import type { DwarChatRequest, DwarChatResponse, DwarMessage, DwarToolUseBlock } from "../types/domain.js";
import { YIELD } from "../types/domain.js";
import type { AssembledContext } from "./context.js";
import type { SteerQueue } from "./steer.js";
import { formatSteerTurn } from "./steer.js";
import { clearOldToolResults, type ClearOldToolResultsOpts } from "./scratchpad.js";
import type { ToolExecResult } from "./tools.js";

export type ReasoningLoopDeps = {
  agentId: string;
  scratchpad: DwarMessage[];
  scratchpadClear: ClearOldToolResultsOpts;
  assemble: () => Promise<AssembledContext>;
  arrivalsSince: (afterSeq: number) => { turn: DwarMessage | null; throughSeq: number };
  reason: (request: DwarChatRequest) => Promise<DwarChatResponse>;
  executeTool: (call: DwarToolUseBlock) => Promise<ToolExecResult>;
  steer: SteerQueue;
  logThought: (response: DwarChatResponse) => Promise<void>;
  logToolCall: (call: DwarToolUseBlock, result: ToolExecResult) => Promise<void>;
  logToolResult: (toolUseId: string, result: ToolExecResult) => Promise<void>;
};

const TERMINATED = "terminated by conversation lane";

/**
 * Reasoning-lane scratchpad loop. Dwar forces tool use; text may accompany tools as
 * internal working output. The only clean exit is the embedded yield tool. A bare
 * response with no tools is a degraded exit; pending steers still continue the loop.
 * Scratchpad holds this wake's tool calls and results, steers, and mid-wake
 * arrivals — cleared when the turn ends so prior yields cannot few-shot the next wake. Each iteration clears older
 * tool_result bodies so long wakes stay near a working-set size.
 *
 * When conversation sets terminate, this wake stops in its tracks: no further
 * tool calls run (in-flight model output is discarded before execution).
 *
 * The transcript is fixed at wake start. Messages that arrive mid-wake and
 * steers are appended to the scratchpad where they happened, so earlier turns
 * never change (keeping the provider cache warm) and steers stay in view for
 * the rest of the wake instead of for a single call.
 */
export async function runReasoningLoop(deps: ReasoningLoopDeps): Promise<void> {
  const scratchpad = deps.scratchpad;
  let transcript: DwarMessage[] | null = null;
  let seenThrough = 0;

  for (;;) {
    if (deps.steer.isTerminate(deps.agentId)) {
      deps.steer.takeTerminate(deps.agentId);
      deps.steer.drain(deps.agentId);
      scratchpad.length = 0;
      return;
    }

    clearOldToolResults(scratchpad, deps.scratchpadClear);
    const assembled = await deps.assemble();
    if (transcript === null) {
      transcript = assembled.messages;
      seenThrough = assembled.throughSeq;
    } else {
      const arrived = deps.arrivalsSince(seenThrough);
      if (arrived.turn !== null) {
        scratchpad.push(arrived.turn);
      }
      seenThrough = arrived.throughSeq;
    }
    const steers = deps.steer.drain(deps.agentId);
    if (steers.length > 0) {
      scratchpad.push({ role: "user", content: formatSteerTurn(steers) });
    }
    const messages: DwarMessage[] = [...transcript, ...scratchpad];

    if (deps.steer.isTerminate(deps.agentId)) {
      deps.steer.takeTerminate(deps.agentId);
      scratchpad.length = 0;
      return;
    }

    const response = await deps.reason({
      system: assembled.system,
      messages,
      tools: assembled.tools,
    });
    await deps.logThought(response);

    if (deps.steer.isTerminate(deps.agentId)) {
      deps.steer.takeTerminate(deps.agentId);
      scratchpad.length = 0;
      return;
    }

    const uses = response.content.filter(
      (block): block is DwarToolUseBlock => block.type === "tool_use",
    );
    if (uses.length === 0) {
      scratchpad.push({ role: "assistant", content: response.content });
      if (deps.steer.hasItems(deps.agentId) || deps.steer.isTerminate(deps.agentId)) {
        continue;
      }
      scratchpad.length = 0;
      return;
    }

    scratchpad.push({ role: "assistant", content: response.content });
    const results = [];
    let yielded = false;
    let stopped = false;
    for (const call of uses) {
      if (deps.steer.isTerminate(deps.agentId) && call.name !== YIELD) {
        const result = {
          content: TERMINATED,
          isError: true,
          audit: { terminated: true },
        };
        await deps.logToolCall(call, result);
        await deps.logToolResult(call.id, result);
        results.push({
          type: "tool_result" as const,
          tool_use_id: call.id,
          content: result.content,
          is_error: true,
        });
        stopped = true;
        continue;
      }
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
      if (deps.steer.isTerminate(deps.agentId) && call.name !== YIELD) {
        stopped = true;
      }
    }
    scratchpad.push({ role: "user", content: results });
    if (yielded || stopped || deps.steer.isTerminate(deps.agentId)) {
      deps.steer.takeTerminate(deps.agentId);
      scratchpad.length = 0;
      return;
    }
  }
}
