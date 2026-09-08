/**
 * Agent runtime: lane locks, steer/intent queues, transcript, and lane runners.
 * Conversation enqueue always schedules a run — the lane lock serializes concurrent
 * wakes so a second user message is not dropped while conversation is busy. Root's
 * empty-work early-return absorbs duplicate wakes once there is nothing left to route.
 */

import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { writeAgentLog } from "../db/logs.js";
import { agents } from "../db/schema.js";
import type { DwarClient } from "../dwar/client.js";
import type { YaadClient } from "../yaad/client.js";
import type { DwarChatResponse, DwarMessage, DwarToolUseBlock, Lane } from "../types/domain.js";
import { assembleContext } from "./context.js";
import { runConversationLoop } from "./conversation.js";
import { EventBus } from "./events.js";
import { IntentQueue } from "./intents.js";
import { LaneLocks } from "./locks.js";
import { runReasoningLoop } from "./reasoning.js";
import { SteerQueue } from "./steer.js";
import { executeTool, type ToolContext, type ToolExecResult } from "./tools.js";
import { TranscriptStore } from "./transcript.js";

export type RuntimeLog = {
  error: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type Runtime = {
  locks: LaneLocks;
  steer: SteerQueue;
  intents: IntentQueue;
  transcript: TranscriptStore;
  events: EventBus;
  enqueueConversation: (agentId: string) => void;
  enqueueReasoning: (agentId: string) => void;
  waitUntilIdle: () => Promise<void>;
  toolContext: (callerId: string, lane: Lane) => ToolContext;
};

/** Wire locks, queues, and lane runners for one process. */
export function createRuntime(opts: {
  db: Db;
  dwar: DwarClient;
  yaad: YaadClient;
  config: Config;
  log: RuntimeLog;
}): Runtime {
  const locks = new LaneLocks();
  const steer = new SteerQueue();
  const intents = new IntentQueue();
  const transcript = new TranscriptStore();
  const events = new EventBus();
  const reasoningScratchpads = new Map<string, DwarMessage[]>();
  const conversationScratchpads = new Map<string, DwarMessage[]>();
  let pending = 0;
  const idleWaiters: Array<() => void> = [];

  function track(work: Promise<void>): void {
    pending += 1;
    void work.finally(() => {
      pending -= 1;
      if (pending === 0) {
        const waiters = idleWaiters.splice(0);
        for (const waiter of waiters) {
          waiter();
        }
      }
    });
  }

  function waitUntilIdle(): Promise<void> {
    if (pending === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  function scratchpadFor(map: Map<string, DwarMessage[]>, agentId: string): DwarMessage[] {
    let pad = map.get(agentId);
    if (!pad) {
      pad = [];
      map.set(agentId, pad);
    }
    return pad;
  }

  const runtime: Runtime = {
    locks,
    steer,
    intents,
    transcript,
    events,
    enqueueConversation,
    enqueueReasoning,
    waitUntilIdle,
    toolContext,
  };

  function toolContext(callerId: string, lane: Lane): ToolContext {
    return {
      db: opts.db,
      callerId,
      lane,
      yaad: opts.yaad,
      steer,
      intents,
      locks,
      transcript,
      events,
      enqueueConversation,
      enqueueReasoning,
    };
  }

  /**
   * Always schedule a conversation run. The lane lock serializes concurrent wakes;
   * dropping here would lose a second user message that arrives while busy.
   */
  function enqueueConversation(agentId: string): void {
    track(runLane(agentId, "conversation"));
  }

  function enqueueReasoning(agentId: string): void {
    track(runLane(agentId, "reasoning"));
  }

  /**
   * Acquire the lane lock and run reasoning or conversation.
   * Root conversation skips the LLM when a wake arrives after route_message with no work left.
   */
  async function runLane(agentId: string, lane: Lane): Promise<void> {
    let release: (() => void) | undefined;
    try {
      release = await locks.acquire(agentId, lane, opts.config.runtime.lane_queue_timeout_ms);
      events.emit({
        type: "lane_started",
        agent_id: agentId,
        lane,
        at: new Date().toISOString(),
      });
      try {
        const rows = await opts.db.select().from(agents).where(eq(agents.id, agentId));
        const agent = rows[0];
        if (!agent || !agent.active) {
          return;
        }
        if (lane === "reasoning") {
          await runReasoningLoop(reasoningDeps(agentId));
        } else {
          if (
            agent.parentAgentId === null &&
            !intents.hasItems(agentId) &&
            transcript.unroutedUserMessages(agentId).length === 0
          ) {
            return;
          }
          await runConversationLoop(conversationDeps(agentId));
        }
      } finally {
        events.emit({
          type: "lane_finished",
          agent_id: agentId,
          lane,
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      opts.log.error({ err, agentId, lane }, `${lane} lane failed`);
    } finally {
      release?.();
      if (lane === "reasoning") {
        enqueueConversation(agentId);
        if (steer.hasItems(agentId)) {
          enqueueReasoning(agentId);
        }
      }
    }
  }

  function laneHelpers(agentId: string, lane: Lane) {
    const assemble = () =>
      assembleContext({
        db: opts.db,
        agentId,
        lane,
        transcript,
      });
    const exec = (call: DwarToolUseBlock) => executeTool(toolContext(agentId, lane), call);
    const logThought = (response: DwarChatResponse) =>
      writeAgentLog(opts.db, {
        agentId,
        lane,
        event: "thought",
        payload: {
          stop_reason: response.stop_reason,
          content: response.content,
          usage: response.usage,
        },
      });
    const logToolCall = (call: DwarToolUseBlock, result: ToolExecResult) =>
      writeAgentLog(opts.db, {
        agentId,
        lane,
        event: "tool_call",
        payload: {
          id: call.id,
          name: call.name,
          input: call.input,
          ...result.audit,
        },
      });
    const logToolResult = (toolUseId: string, result: ToolExecResult) =>
      writeAgentLog(opts.db, {
        agentId,
        lane,
        event: "tool_result",
        payload: {
          tool_use_id: toolUseId,
          content: result.content,
          is_error: result.isError,
        },
      });
    return { assemble, exec, logThought, logToolCall, logToolResult };
  }

  function reasoningDeps(agentId: string) {
    const helpers = laneHelpers(agentId, "reasoning");
    return {
      agentId,
      scratchpad: scratchpadFor(reasoningScratchpads, agentId),
      assemble: helpers.assemble,
      reason: opts.dwar.reason,
      executeTool: helpers.exec,
      steer,
      logThought: helpers.logThought,
      logToolCall: helpers.logToolCall,
      logToolResult: helpers.logToolResult,
    };
  }

  function conversationDeps(agentId: string) {
    const helpers = laneHelpers(agentId, "conversation");
    return {
      agentId,
      scratchpad: scratchpadFor(conversationScratchpads, agentId),
      assemble: helpers.assemble,
      converse: opts.dwar.converse,
      executeTool: helpers.exec,
      intents,
      logThought: helpers.logThought,
      logToolCall: helpers.logToolCall,
      logToolResult: helpers.logToolResult,
    };
  }

  return runtime;
}
