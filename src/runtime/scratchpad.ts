/** Mid-wake scratchpad tool-result clearing (Anthropic-style keep + batch + budget). */

import type { DwarContentBlock, DwarMessage, DwarToolResultBlock } from "../types/domain.js";

const CLEARED_PREFIX = "[cleared — you already saw this full result earlier this wake";

/** How many leading chars of a cleared tool_result body stay visible. */
export const CLEARED_HEAD_CHARS = 240;

/**
 * clearedToolResult is what replaces a cleared tool_result body: a notice that
 * the call already ran plus the head of its output, so ids and outcomes stay in
 * view and the model has no reason to re-run the call just to reread it.
 */
export function clearedToolResult(content: string): string {
  const head = content.slice(0, CLEARED_HEAD_CHARS);
  const ellipsis = content.length > CLEARED_HEAD_CHARS ? "…" : "";
  return `${CLEARED_PREFIX}; do not repeat the call just to reread it. It began: ${head}${ellipsis}]`;
}

/** isClearedToolResult reports whether a tool_result body has already been cleared. */
export function isClearedToolResult(content: string): boolean {
  return content.startsWith(CLEARED_PREFIX);
}

export type ClearOldToolResultsOpts = {
  /** How many newest tool-result user turns keep full payloads. */
  keep: number;
  /** How many extra full tool-result turns may pile up past `keep` before they are cleared together (0 clears every step). */
  batch: number;
  /** Soft char budget across all tool_result content; clear older until under. */
  maxChars: number;
};

/**
 * clearOldToolResults replaces older tool_result bodies in place so mid-wake
 * Dwar calls stay near a working-set size. Full tool-result turns may grow to
 * `keep + batch`; past that, all but the newest `keep` are cleared at once, so
 * the history prefix stays byte-identical (and provider-cached) between clears.
 * Then clears further from oldest if total chars still exceed `maxChars`
 * (always leaves the newest tool-result turn full). Preserves tool_use_id and
 * is_error. Assistant tool_use blocks are untouched.
 */
export function clearOldToolResults(
  scratchpad: DwarMessage[],
  opts: ClearOldToolResultsOpts,
): void {
  if (opts.keep < 1) {
    throw new Error("scratchpad_keep_tool_results must be >= 1");
  }
  if (opts.batch < 0) {
    throw new Error("scratchpad_clear_batch_tool_results must be >= 0");
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

  const protectedNewest = resultTurnIndexes[resultTurnIndexes.length - 1]!;
  const full = resultTurnIndexes.filter((idx) => turnHasUnclearedResults(scratchpad[idx]!));
  if (full.length > opts.keep + opts.batch) {
    for (const idx of full.slice(0, full.length - opts.keep)) {
      clearTurnResults(scratchpad, idx);
    }
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
      if (isClearedToolResult(block.content)) {
        continue;
      }
      total += block.content.length;
    }
  }
  return total;
}

function turnHasUnclearedResults(message: DwarMessage): boolean {
  return toolResultsOf(message).some((block) => !isClearedToolResult(block.content));
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
    if (isClearedToolResult(block.content)) {
      return block;
    }
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: clearedToolResult(block.content),
      is_error: block.is_error,
    };
  });
  scratchpad[index] = { role: "user", content: next };
}
