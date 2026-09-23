/** Mid-wake scratchpad tool-result clearing (Anthropic-style keep + budget). */

import type { DwarContentBlock, DwarMessage, DwarToolResultBlock } from "../types/domain.js";

/** Placeholder left in place of a cleared tool_result body. */
export const CLEARED_TOOL_RESULT =
  "[cleared — call the tool again if you still need this output]";

export type ClearOldToolResultsOpts = {
  /** How many newest tool-result user turns keep full payloads. */
  keep: number;
  /** Soft char budget across all tool_result content; clear older until under. */
  maxChars: number;
};

/**
 * clearOldToolResults replaces older tool_result bodies in place so mid-wake
 * Dwar calls stay near a working-set size. Keeps the last `keep` tool-result
 * user turns intact, then clears further from oldest if total chars still
 * exceed `maxChars` (always leaves the newest tool-result turn full).
 * Preserves tool_use_id and is_error. Assistant tool_use blocks are untouched.
 */
export function clearOldToolResults(
  scratchpad: DwarMessage[],
  opts: ClearOldToolResultsOpts,
): void {
  if (opts.keep < 1) {
    throw new Error("scratchpad_keep_tool_results must be >= 1");
  }
  if (opts.maxChars < 1) {
    throw new Error("scratchpad_tool_result_max_chars must be >= 1");
  }

  const resultTurnIndexes: number[] = [];
  for (let i = 0; i < scratchpad.length; i++) {
    if (toolResultsOf(scratchpad[i]).length > 0) {
      resultTurnIndexes.push(i);
    }
  }
  if (resultTurnIndexes.length === 0) {
    return;
  }

  const keepFrom = Math.max(0, resultTurnIndexes.length - opts.keep);
  const protectedNewest = resultTurnIndexes[resultTurnIndexes.length - 1]!;

  for (let i = 0; i < keepFrom; i++) {
    clearTurnResults(scratchpad, resultTurnIndexes[i]!);
  }

  while (totalToolResultChars(scratchpad) > opts.maxChars) {
    const next = resultTurnIndexes.find(
      (idx) => idx !== protectedNewest && turnHasUnclearedResults(scratchpad[idx]!),
    );
    if (next === undefined) {
      break;
    }
    clearTurnResults(scratchpad, next);
  }
}

function toolResultsOf(message: DwarMessage | undefined): DwarToolResultBlock[] {
  if (!message || message.role !== "user" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter(
    (block): block is DwarToolResultBlock => block.type === "tool_result",
  );
}

function totalToolResultChars(scratchpad: DwarMessage[]): number {
  let total = 0;
  for (const message of scratchpad) {
    for (const block of toolResultsOf(message)) {
      if (block.content === CLEARED_TOOL_RESULT) {
        continue;
      }
      total += block.content.length;
    }
  }
  return total;
}

function turnHasUnclearedResults(message: DwarMessage): boolean {
  return toolResultsOf(message).some((block) => block.content !== CLEARED_TOOL_RESULT);
}

function clearTurnResults(scratchpad: DwarMessage[], index: number): void {
  const message = scratchpad[index];
  if (!message || !Array.isArray(message.content)) {
    return;
  }
  const next: DwarContentBlock[] = message.content.map((block) => {
    if (block.type !== "tool_result") {
      return block;
    }
    if (block.content === CLEARED_TOOL_RESULT) {
      return block;
    }
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: CLEARED_TOOL_RESULT,
      is_error: block.is_error,
    };
  });
  scratchpad[index] = { role: "user", content: next };
}
