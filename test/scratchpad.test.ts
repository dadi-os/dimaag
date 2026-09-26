import assert from "node:assert/strict";
import { test } from "node:test";
import type { DwarChatRequest, DwarChatResponse, DwarMessage } from "../src/types/domain.js";
import { runConversationLoop } from "../src/runtime/conversation.js";
import { IntentQueue } from "../src/runtime/intents.js";
import { runReasoningLoop } from "../src/runtime/reasoning.js";
import { SteerQueue } from "../src/runtime/steer.js";
import {
  CLEARED_HEAD_CHARS,
  clearOldToolResults,
  clearedToolResult,
  isClearedToolResult,
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
  clearOldToolResults(pad, { keep: 5, batch: 0, maxChars: 1000 });
  assert.deepEqual(pad, []);
});

test("clearOldToolResults keeps the last N tool-result turns full", () => {
  const pad: DwarMessage[] = [];
  for (let i = 0; i < 8; i++) {
    pad.push(assistantToolUse(`u${i}`, "browser_click"));
    pad.push(toolResultTurn(`u${i}`, `payload-${i}-xxxxxxxxxx`));
  }
  clearOldToolResults(pad, { keep: 3, batch: 0, maxChars: 1_000_000 });

  const results = pad.filter(
    (m) => m.role === "user" && Array.isArray(m.content),
  );
  assert.equal(results.length, 8);
  for (let i = 0; i < 5; i++) {
    const block = (results[i]!.content as { content: string }[])[0];
    assert.equal(block?.content, clearedToolResult(`payload-${i}-xxxxxxxxxx`));
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
  clearOldToolResults(pad, { keep: 1, batch: 0, maxChars: 1_000_000 });
  const cleared = pad[1]!.content as {
    type: string;
    tool_use_id: string;
    content: string;
    is_error: boolean;
  }[];
  assert.equal(cleared[0]?.tool_use_id, "call-a");
  assert.equal(cleared[0]?.is_error, true);
  assert.equal(cleared[0]?.content, clearedToolResult("old bulky result"));
});

test("clearOldToolResults keeps the head of a cleared result and never re-clears it", () => {
  const vaultHit = '{"items":[{"id":"57403950-98d7","name":"LinkedIn"}]}';
  const bulky = "tree " + "z".repeat(CLEARED_HEAD_CHARS * 4);
  const pad: DwarMessage[] = [
    assistantToolUse("v1", "chaavi_list_items"),
    toolResultTurn("v1", vaultHit),
    assistantToolUse("t1", "browser_accessibility_tree"),
    toolResultTurn("t1", bulky),
    assistantToolUse("n1", "browser_navigate"),
    toolResultTurn("n1", "newest"),
  ];
  clearOldToolResults(pad, { keep: 1, batch: 0, maxChars: 1_000_000 });

  const vault = (pad[1]!.content as { content: string }[])[0]!.content;
  assert.ok(isClearedToolResult(vault));
  assert.ok(vault.includes("57403950-98d7"));
  const tree = (pad[3]!.content as { content: string }[])[0]!.content;
  assert.ok(tree.length < bulky.length / 2);
  clearOldToolResults(pad, { keep: 1, batch: 0, maxChars: 1_000_000 });
  assert.equal((pad[1]!.content as { content: string }[])[0]!.content, vault);
});

test("clearOldToolResults clears in batches so earlier turns stay byte-identical between clears", () => {
  const pad: DwarMessage[] = [];
  const snapshots: string[] = [];
  let clears = 0;
  for (let step = 0; step < 20; step++) {
    pad.push(assistantToolUse(`s${step}`, "browser_click"));
    pad.push(toolResultTurn(`s${step}`, `result-${step}`));
    const before = JSON.stringify(pad.slice(0, -2));
    clearOldToolResults(pad, { keep: 5, batch: 5, maxChars: 1_000_000 });
    if (JSON.stringify(pad.slice(0, -2)) !== before) {
      clears += 1;
    }
    const full = pad.filter(
      (m) =>
        m.role === "user" &&
        !isClearedToolResult((m.content as { content: string }[])[0]!.content),
    ).length;
    assert.ok(full >= Math.min(step + 1, 5) && full <= 10, `step ${step}: ${full} full results`);
    snapshots.push(JSON.stringify(pad));
  }
  assert.equal(clears, 2);
});

test("clearOldToolResults clears further when over maxChars, leaving newest full", () => {
  const pad: DwarMessage[] = [];
  for (let i = 0; i < 4; i++) {
    pad.push(assistantToolUse(`u${i}`, "browser_extract_text"));
    pad.push(toolResultTurn(`u${i}`, "x".repeat(100)));
  }
  clearOldToolResults(pad, { keep: 4, batch: 0, maxChars: 150 });

  const results = pad.filter(
    (m) => m.role === "user" && Array.isArray(m.content),
  );
  const newest = (results[3]!.content as { content: string }[])[0];
  assert.equal(newest?.content, "x".repeat(100));
  const olderFull = results
    .slice(0, 3)
    .filter(
      (m) =>
        !isClearedToolResult((m.content as { content: string }[])[0]!.content),
    );
  assert.equal(olderFull.length, 0);
});

test("clearOldToolResults keeps long wakes bounded across many iterations", () => {
  const pad: DwarMessage[] = [];
  for (let step = 0; step < 60; step++) {
    pad.push(assistantToolUse(`s${step}`, "browser_click"));
    pad.push(toolResultTurn(`s${step}`, `result-body-${step}-` + "y".repeat(200)));
    clearOldToolResults(pad, { keep: 5, batch: 0, maxChars: 2000 });
  }
  let chars = 0;
  for (const message of pad) {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_result" && !isClearedToolResult(block.content)) {
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
    scratchpadClear: { keep: 2, batch: 0, maxChars: 1_000_000 },
    assemble: async () => ({ system: "sys", messages: [], tools: [], throughSeq: 0 }),
    arrivalsSince: (afterSeq) => ({ turn: null, throughSeq: afterSeq }),
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

  assert.ok(seenPayloads.some(isClearedToolResult));
  assert.ok(seenPayloads.some((p) => p.startsWith("full-result-")));
});

function intentToolUse(name: string, id = name): DwarChatResponse {
  return {
    content: [{ type: "tool_use", id, name, input: {} }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

test("a conversation intent stays in view while the lane keeps calling tools", async () => {
  const intents = new IntentQueue();
  const agentId = "agent-intent-persist";
  intents.append(agentId, { toAgentId: null, intent: "tell Ankur the profile URL" });
  const calls: DwarChatRequest[] = [];
  let turn = 0;

  await runConversationLoop({
    agentId,
    scratchpad: [],
    scratchpadClear: { keep: 5, batch: 5, maxChars: 80_000 },
    assemble: async () => ({ system: "sys", messages: [], tools: [] }),
    converse: async (request) => {
      calls.push(structuredClone(request));
      turn += 1;
      return turn < 3
        ? intentToolUse("list_agents", `l${turn}`)
        : intentToolUse("yield");
    },
    executeTool: async () => ({ content: "{}", isError: false, audit: {} }),
    intents,
    logThought: async () => {},
    logToolCall: async () => {},
    logToolResult: async () => {},
  });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    const texts = call.messages.map((message) =>
      typeof message.content === "string" ? message.content : "",
    );
    assert.ok(texts.some((text) => text.includes("tell Ankur the profile URL")));
  }
});
