import assert from "node:assert/strict";
import { test } from "node:test";
import type { DwarMessage } from "../src/types/domain.js";
import { runReasoningLoop } from "../src/runtime/reasoning.js";
import { SteerQueue } from "../src/runtime/steer.js";
import {
  CLEARED_TOOL_RESULT,
  clearOldToolResults,
} from "../src/runtime/scratchpad.js";

function toolResultTurn(id: string, content: string): DwarMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content,
        is_error: false,
      },
    ],
  };
}

function assistantToolUse(id: string, name: string): DwarMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

test("clearOldToolResults is a no-op on an empty pad", () => {
  const pad: DwarMessage[] = [];
  clearOldToolResults(pad, { keep: 5, maxChars: 1000 });
  assert.deepEqual(pad, []);
});

test("clearOldToolResults keeps the last N tool-result turns full", () => {
  const pad: DwarMessage[] = [];
  for (let i = 0; i < 8; i++) {
    pad.push(assistantToolUse(`u${i}`, "browser_click"));
    pad.push(toolResultTurn(`u${i}`, `payload-${i}-xxxxxxxxxx`));
  }
  clearOldToolResults(pad, { keep: 3, maxChars: 1_000_000 });

  const results = pad.filter(
    (m) => m.role === "user" && Array.isArray(m.content),
  );
  assert.equal(results.length, 8);
  for (let i = 0; i < 5; i++) {
    const block = (results[i]!.content as { content: string }[])[0];
    assert.equal(block?.content, CLEARED_TOOL_RESULT);
  }
  for (let i = 5; i < 8; i++) {
    const block = (results[i]!.content as { content: string }[])[0];
    assert.equal(block?.content, `payload-${i}-xxxxxxxxxx`);
  }
  const uses = pad.filter((m) => m.role === "assistant");
  assert.equal(uses.length, 8);
  assert.equal(
    (uses[0]!.content as { type: string }[])[0]?.type,
    "tool_use",
  );
});

test("clearOldToolResults preserves tool_use_id and is_error when clearing", () => {
  const pad: DwarMessage[] = [
    assistantToolUse("call-a", "yaad_recall"),
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-a",
          content: "old bulky result",
          is_error: true,
        },
      ],
    },
    assistantToolUse("call-b", "yaad_recall"),
    toolResultTurn("call-b", "kept"),
  ];
  clearOldToolResults(pad, { keep: 1, maxChars: 1_000_000 });
  const cleared = pad[1]!.content as {
    type: string;
    tool_use_id: string;
    content: string;
    is_error: boolean;
  }[];
  assert.equal(cleared[0]?.tool_use_id, "call-a");
  assert.equal(cleared[0]?.is_error, true);
  assert.equal(cleared[0]?.content, CLEARED_TOOL_RESULT);
});

test("clearOldToolResults clears further when over maxChars, leaving newest full", () => {
  const pad: DwarMessage[] = [];
  for (let i = 0; i < 4; i++) {
    pad.push(assistantToolUse(`u${i}`, "browser_extract_text"));
    pad.push(toolResultTurn(`u${i}`, "x".repeat(100)));
  }
  clearOldToolResults(pad, { keep: 4, maxChars: 150 });

  const results = pad.filter(
    (m) => m.role === "user" && Array.isArray(m.content),
  );
  const newest = (results[3]!.content as { content: string }[])[0];
  assert.equal(newest?.content, "x".repeat(100));
  const olderFull = results
    .slice(0, 3)
    .filter(
      (m) =>
        (m.content as { content: string }[])[0]?.content !== CLEARED_TOOL_RESULT,
    );
  assert.equal(olderFull.length, 0);
});

test("clearOldToolResults keeps long wakes bounded across many iterations", () => {
  const pad: DwarMessage[] = [];
  for (let step = 0; step < 60; step++) {
    pad.push(assistantToolUse(`s${step}`, "browser_click"));
    pad.push(toolResultTurn(`s${step}`, `result-body-${step}-` + "y".repeat(200)));
    clearOldToolResults(pad, { keep: 5, maxChars: 2000 });
  }
  let chars = 0;
  for (const message of pad) {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_result" && block.content !== CLEARED_TOOL_RESULT) {
        chars += block.content.length;
      }
    }
  }
  assert.ok(chars <= 2000, `expected uncleared chars <= 2000, got ${chars}`);
  assert.equal(pad.length, 120);
});

test("reasoning loop clears old tool results before each provider call", async () => {
  const steer = new SteerQueue();
  const agentId = "loop-clear-agent";
  const scratchpad: DwarMessage[] = [];
  const seenPayloads: string[] = [];
  let turn = 0;

  await runReasoningLoop({
    agentId,
    scratchpad,
    scratchpadClear: { keep: 2, maxChars: 1_000_000 },
    assemble: async () => ({ system: "sys", messages: [], tools: [] }),
    reason: async (request) => {
      turn += 1;
      for (const message of request.messages) {
        if (message.role !== "user" || !Array.isArray(message.content)) {
          continue;
        }
        for (const block of message.content) {
          if (block.type === "tool_result") {
            seenPayloads.push(block.content);
          }
        }
      }
      if (turn <= 5) {
        return {
          content: [
            {
              type: "tool_use",
              id: `c${turn}`,
              name: "browser_click",
              input: {},
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      return {
        content: [{ type: "tool_use", id: "y1", name: "yield", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
    executeTool: async (call) => ({
      content: `full-result-${call.id}`,
      isError: false,
      audit: {},
    }),
    steer,
    logThought: async () => {},
    logToolCall: async () => {},
    logToolResult: async () => {},
  });

  assert.ok(seenPayloads.includes(CLEARED_TOOL_RESULT));
  assert.ok(seenPayloads.some((p) => p.startsWith("full-result-")));
});
