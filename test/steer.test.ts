import assert from "node:assert/strict";
import { test } from "node:test";
import type { DwarChatRequest, DwarChatResponse } from "../src/types/domain.js";
import { runReasoningLoop } from "../src/runtime/reasoning.js";
import { SteerQueue, STEER_TURN_PREFIX } from "../src/runtime/steer.js";
import { LaneLocks } from "../src/runtime/locks.js";
import { IntentQueue } from "../src/runtime/intents.js";
import { executeTool } from "../src/runtime/tools.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { STEER_REASONING } from "../src/types/domain.js";

function endTurn(text = "done"): DwarChatResponse {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function toolUse(name: string, input: unknown): DwarChatResponse {
  return {
    content: [{ type: "tool_use", id: "call-1", name, input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

test("a steer arriving mid-loop is applied on the next iteration", async () => {
  const steer = new SteerQueue();
  const agentId = "agent-1";
  const calls: DwarChatRequest[] = [];
  let turn = 0;
  const scratchpad: DwarChatRequest["messages"] = [];

  await runReasoningLoop({
    agentId,
    scratchpad,
    assemble: async () => ({ system: "sys", messages: [], tools: [] }),
    reason: async (request) => {
      calls.push(request);
      turn += 1;
      if (turn === 1) {
        steer.append(agentId, "check the voice PR");
        return toolUse("send_message", { to_agent_id: null, intent: "status" });
      }
      return endTurn();
    },
    executeTool: async () => ({ content: "{}", isError: false, audit: {} }),
    steer,
    logThought: async () => {},
    logToolCall: async () => {},
    logToolResult: async () => {},
  });

  assert.equal(calls.length, 2);
  const second = calls[1];
  assert.ok(second);
  const texts = second.messages.map((message) =>
    typeof message.content === "string" ? message.content : "",
  );
  assert.ok(texts.some((text) => text.includes(STEER_TURN_PREFIX) && text.includes("check the voice PR")));
});

test("steer_reasoning starts a run when reasoning is idle", async () => {
  const locks = new LaneLocks();
  const steer = new SteerQueue();
  const started: string[] = [];
  const agentId = "00000000-0000-4000-8000-0000000000dd";
  const result = await executeTool(
    {
      db: {} as never,
      callerId: agentId,
      lane: "conversation",
      steer,
      intents: new IntentQueue(),
      locks,
      transcript: new TranscriptStore(),
      enqueueConversation: () => {},
      enqueueReasoning: (id) => {
        started.push(id);
      },
    },
    {
      type: "tool_use",
      id: "s1",
      name: STEER_REASONING,
      input: { instruction: "look into it" },
    },
  );
  assert.equal(result.isError, false);
  assert.deepEqual(started, [agentId]);
  assert.equal(steer.hasItems(agentId), true);
});

test("steer_reasoning does not start a second run while reasoning is busy", async () => {
  const locks = new LaneLocks();
  const steer = new SteerQueue();
  const agentId = "00000000-0000-4000-8000-0000000000ee";
  const release = await locks.acquire(agentId, "reasoning", 1000);
  const started: string[] = [];
  await executeTool(
    {
      db: {} as never,
      callerId: agentId,
      lane: "conversation",
      steer,
      intents: new IntentQueue(),
      locks,
      transcript: new TranscriptStore(),
      enqueueConversation: () => {},
      enqueueReasoning: (id) => {
        started.push(id);
      },
    },
    {
      type: "tool_use",
      id: "s2",
      name: STEER_REASONING,
      input: { instruction: "wait your turn" },
    },
  );
  release();
  assert.deepEqual(started, []);
  assert.equal(steer.hasItems(agentId), true);
});
