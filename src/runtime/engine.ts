import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { writeAgentLog } from "../db/logs.js";
import { agents } from "../db/schema.js";
import type { DwarClient } from "../dwar/client.js";
import type { DwarChatResponse, DwarToolUseBlock, Lane } from "../types/domain.js";
import { assembleContext } from "./context.js";
import { runConversationLoop } from "./conversation.js";
import { IntentQueue } from "./intents.js";
import { LaneLocks } from "./locks.js";
import { runReasoningLoop } from "./reasoning.js";
import { SteerQueue } from "./steer.js";
import { executeTool, type ToolContext, type ToolExecResult } from "./tools.js";

export type RuntimeLog = {
  error: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type Runtime = {
  locks: LaneLocks;
  steer: SteerQueue;
  intents: IntentQueue;
  enqueueConversation: (agentId: string) => void;
  enqueueReasoning: (agentId: string) => void;
  waitUntilIdle: () => Promise<void>;
  toolContext: (callerId: string, lane: Lane) => ToolContext;
};

export function createRuntime(opts: {
  db: Db;
  dwar: DwarClient;
  config: Config;
  log: RuntimeLog;
}): Runtime {
  const locks = new LaneLocks();
  const steer = new SteerQueue();
  const intents = new IntentQueue();
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

  const runtime: Runtime = {
    locks,
    steer,
    intents,
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
      steer,
      intents,
      locks,
      enqueueConversation,
      enqueueReasoning,
    };
  }

  function enqueueConversation(agentId: string): void {
    track(runLane(agentId, "conversation"));
  }

  function enqueueReasoning(agentId: string): void {
    track(runLane(agentId, "reasoning"));
  }

  async function runLane(agentId: string, lane: Lane): Promise<void> {
    let release: (() => void) | undefined;
    try {
      release = await locks.acquire(agentId, lane, opts.config.runtime.lane_queue_timeout_ms);
      const rows = await opts.db.select().from(agents).where(eq(agents.id, agentId));
      const agent = rows[0];
      if (!agent || !agent.active) {
        return;
      }
      if (lane === "reasoning") {
        await runReasoningLoop(reasoningDeps(agentId));
      } else {
        await runConversationLoop(conversationDeps(agentId));
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
        maxTranscriptMessages: opts.config.context.max_transcript_messages,
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
      maxIterations: opts.config.runtime.max_scratchpad_iterations,
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
      maxIterations: opts.config.runtime.max_conversation_iterations,
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
