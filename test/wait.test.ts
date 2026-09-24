import assert from "node:assert/strict";
import { test } from "node:test";
import { executeTool } from "../src/runtime/tools.js";
import { SteerQueue } from "../src/runtime/steer.js";
import { HostSessions } from "../src/runtime/sessions.js";
import { ToolDebounce } from "../src/runtime/tool-debounce.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { LaneLocks } from "../src/runtime/locks.js";
import { IntentQueue } from "../src/runtime/intents.js";
import { WAIT } from "../src/types/domain.js";
import type { ToolContext } from "../src/tools/shared.js";

const agentId = "wait-worker";

function ctxFor(steer: SteerQueue): ToolContext {
  return {
    db: {} as never,
    callerId: agentId,
    callerKind: "agent",
    lane: "reasoning",
    steer,
    intents: new IntentQueue(),
    locks: new LaneLocks(),
    transcript: new TranscriptStore(),
    sessions: new HostSessions(),
    toolDebounce: new ToolDebounce({ base_ms: 1, max_ms: 1 }),
    enqueueConversation: () => {},
    enqueueReasoning: () => {},
  } as unknown as ToolContext;
}

function waitCall(input: unknown) {
  return { type: "tool_use" as const, id: "w1", name: WAIT, input };
}

test("wait rejects a duration over the max", async () => {
  const result = await executeTool(ctxFor(new SteerQueue()), waitCall({ seconds: 100000 }));
  assert.equal(result.isError, true);
});

test("wait rejects a non-positive duration", async () => {
  const result = await executeTool(ctxFor(new SteerQueue()), waitCall({ seconds: 0 }));
  assert.equal(result.isError, true);
});

test("a pending steer cuts the wait short", async () => {
  const steer = new SteerQueue();
  steer.append(agentId, "new instruction");
  const started = Date.now();
  const result = await executeTool(ctxFor(steer), waitCall({ seconds: 30 }));
  assert.equal(result.isError, false);
  assert.ok(Date.now() - started < 1000);
  assert.equal(JSON.parse(result.content).interrupted, true);
});

test("terminate cuts the wait short", async () => {
  const steer = new SteerQueue();
  steer.requestTerminate(agentId);
  const started = Date.now();
  const result = await executeTool(ctxFor(steer), waitCall({ seconds: 30 }));
  assert.equal(result.isError, false);
  assert.ok(Date.now() - started < 1000);
  assert.equal(JSON.parse(result.content).interrupted, true);
});

test("an uninterrupted wait runs the full duration", async () => {
  const started = Date.now();
  const result = await executeTool(ctxFor(new SteerQueue()), waitCall({ seconds: 1 }));
  assert.equal(result.isError, false);
  assert.ok(Date.now() - started >= 950);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.interrupted, false);
  assert.equal(parsed.waited_seconds, 1);
});
