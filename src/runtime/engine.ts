/**
 * Agent runtime: lane locks, steer/intent queues, transcript, and lane runners.
 * Conversation enqueue always schedules a run — the lane lock serializes concurrent
 * wakes so a second user message is not dropped while conversation is busy.
 * Reasoning does not wake conversation on exit; send_message already enqueues when
 * it queues an intent. A blanket wake races a follow-up run whose transcript ends
 * on an assistant turn, which chat providers reject.
 */

import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { DimaagError } from "../errors.js";
import { writeAgentLog } from "../db/logs.js";
import { agents } from "../db/schema.js";
import { BrowserDriver } from "../browser/driver.js";
import type { ChaaviClient } from "../chaavi/client.js";
import type { DwarClient } from "../dwar/client.js";
import type { GharClient } from "../ghar/client.js";
import type { NasClient } from "../nas/client.js";
import type { YaadClient } from "../yaad/client.js";
import type {
  DwarChatRequest,
  DwarChatResponse,
  DwarToolUseBlock,
  Lane,
  RoutedMessage,
} from "../types/domain.js";
import { arrivalsSince, assembleContext } from "./context.js";
import { deliverAgentMessage } from "./deliver.js";
import { runConversationLoop } from "./conversation.js";
import { EventBus } from "./events.js";
import { HathGateway } from "./hath.js";
import { IntentQueue } from "./intents.js";
import { LaneLocks } from "./locks.js";
import { runReasoningLoop } from "./reasoning.js";
import { SteerQueue } from "./steer.js";
import { HostSessions } from "./sessions.js";
import { ToolDebounce } from "./tool-debounce.js";
import { executeTool, type ToolContext, type ToolExecResult } from "./tools.js";
import type { ToolCallerKind } from "../tools/shared.js";
import { TranscriptStore } from "./transcript.js";
import { Wake, WakeStore } from "./wake.js";
import { ROUTER_KEY } from "./router.js";
import { laneRequest, runStep, syncWake, type StepDeps } from "./step.js";
import { insertMessage, messageToTranscriptEntry } from "../db/messages.js";
import { SEND_MESSAGE } from "../types/domain.js";
import { createScheduler, type Scheduler } from "./scheduler.js";

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
  hath: HathGateway;
  browsers: BrowserDriver;
  sessions: HostSessions;
  scheduler: Scheduler;
  enqueueConversation: (agentId: string) => void;
  enqueueReasoning: (agentId: string) => void;
  waitUntilIdle: () => Promise<void>;
  /** Run the router on one utterance from Ankur; resolves with every message it sent as him. */
  route: (content: string) => Promise<RoutedMessage[]>;
  toolContext: (
    callerId: string | null,
    lane: Lane,
    callerKind?: ToolCallerKind,
  ) => ToolContext;
};

/** Wire locks, queues, and lane runners for one process. */
export function createRuntime(opts: {
  db: Db;
  dwar: DwarClient;
  yaad: YaadClient;
  ghar: GharClient;
  chaavi: ChaaviClient;
  nas: NasClient;
  config: Config;
  log: RuntimeLog;
}): Runtime {
  const locks = new LaneLocks();
  const steer = new SteerQueue();
  const intents = new IntentQueue();
  const transcript = new TranscriptStore();
  const events = new EventBus(opts.log);
  const hath = new HathGateway(events, opts.config.hath.timeout_ms);
  const browsers = new BrowserDriver(opts.nas, opts.config, opts.log);
  const sessions = new HostSessions();
  const toolDebounce = new ToolDebounce({
    base_ms: opts.config.runtime.tool_debounce_base_ms,
    max_ms: opts.config.runtime.tool_debounce_max_ms,
  });
  const wakes = new WakeStore();
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

  /**
   * Always schedule a conversation run. The lane lock serializes concurrent wakes;
   * dropping here would lose a second user message that arrives while busy.
   */
  function enqueueConversation(agentId: string): void {
    track(runLane(agentId, "conversation", wakes.hold(agentId)));
  }

  function enqueueReasoning(agentId: string): void {
    track(runLane(agentId, "reasoning", wakes.hold(agentId)));
  }

  const scheduler = createScheduler({
    db: opts.db,
    transcript,
    events,
    enqueueConversation,
    log: opts.log,
    tickSeconds: opts.config.schedule.tick_seconds,
  });

  const runtime: Runtime = {
    locks,
    steer,
    intents,
    transcript,
    events,
    hath,
    browsers,
    sessions,
    scheduler,
    enqueueConversation,
    enqueueReasoning,
    waitUntilIdle,
    route,
    toolContext,
  };

  function toolContext(
    callerId: string | null,
    lane: Lane,
    callerKind: ToolCallerKind = callerId === null ? "router" : "agent",
  ): ToolContext {
    return {
      db: opts.db,
      callerId,
      callerKind,
      lane,
      yaad: opts.yaad,
      ghar: opts.ghar,
      chaavi: opts.chaavi,
      nas: opts.nas,
      dwar: opts.dwar,
      browsers,
      hath,
      steer,
      intents,
      locks,
      transcript,
      events,
      sessions,
      toolDebounce,
      enqueueConversation,
      enqueueReasoning,
    };
  }

  /**
   * Acquire the lane lock and run reasoning or conversation. `releaseWake` is
   * this run's hold on the agent's shared wake, taken when the run was queued
   * and released last, after any follow-up run has taken its own hold.
   */
  async function runLane(agentId: string, lane: Lane, releaseWake: () => void): Promise<void> {
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
      const message = err instanceof Error ? err.message : String(err);
      opts.log.error({ err, agentId, lane }, `${lane} lane failed`);
      events.emit({
        type: "lane_failed",
        agent_id: agentId,
        lane,
        message,
        at: new Date().toISOString(),
      });
      if (lane === "reasoning") {
        await reportReasoningFailure(agentId, message).catch((reportErr: unknown) => {
          opts.log.error({ err: reportErr, agentId }, "reasoning failure report failed");
        });
      }
    } finally {
      release?.();
      if (lane === "reasoning") {
        if (steer.hasItems(agentId)) {
          enqueueReasoning(agentId);
        }
      }
      releaseWake();
    }
  }

  /**
   * reportReasoningFailure tells the failed agent's parent (or Ankur, for a root
   * agent) that its wake died, as a durable message that also wakes the
   * recipient — otherwise a crashed wake is indistinguishable from a slow one
   * and the parent polls a dead worker.
   */
  async function reportReasoningFailure(agentId: string, message: string): Promise<void> {
    const [agent] = await opts.db
      .select({ parentAgentId: agents.parentAgentId })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (!agent) {
      throw new DimaagError(404, "not_found", `agent ${agentId} not found`);
    }
    await deliverAgentMessage(
      { db: opts.db, transcript, events, enqueueConversation },
      {
        fromAgentId: agentId,
        toAgentId: agent.parentAgentId,
        content: `[runtime] My reasoning lane failed and this wake stopped before finishing: ${message}. Work after my last update was not done; wake me with a message to retry.`,
      },
    );
  }

  /** Null agentId is the router. */
  function laneHelpers(agentId: string | null, lane: Lane) {
    const assemble = () =>
      assembleContext({
        db: opts.db,
        agentId,
        lane,
        transcript,
        serviceRoot: opts.config.serviceRoot,
        transcriptWindowMessages: opts.config.runtime.transcript_window_messages,
        transcriptWindowStep: opts.config.runtime.transcript_window_step_messages,
      });
    const exec = (call: DwarToolUseBlock) => executeTool(toolContext(agentId, lane), call);
    const logResponse = (response: DwarChatResponse) =>
      writeAgentLog(opts.db, {
        agentId,
        lane,
        event: "response",
        payload: {
          provider: response.provider,
          stop_reason: response.stop_reason,
          content: response.content,
          usage: response.usage,
        },
      });
    const logToolResult = (call: DwarToolUseBlock, result: ToolExecResult) =>
      writeAgentLog(opts.db, {
        agentId,
        lane,
        event: "tool_result",
        payload: {
          tool_use_id: call.id,
          name: call.name,
          content: result.content,
          is_error: result.isError,
          ...result.audit,
        },
      });
    return { assemble, exec, logResponse, logToolResult };
  }

  function stepDeps(agentId: string, lane: Lane) {
    const helpers = laneHelpers(agentId, lane);
    return {
      agentId,
      lane,
      wake: wakes.get(agentId),
      assemble: helpers.assemble,
      arrivalsSince: (afterSeq: number) => arrivalsSince(transcript, agentId, afterSeq),
      executeTool: helpers.exec,
      logResponse: helpers.logResponse,
      logToolResult: helpers.logToolResult,
    };
  }

  /**
   * The router's run: persist Ankur's utterance as a null→null message so it is
   * never lost and joins the router's transcript, then loop the router lane on
   * Dwar's context-free chat/complete until it yields. Runs are serialized; each
   * starts a fresh wake from the transcript. Nothing caps the loop.
   */
  async function route(content: string): Promise<RoutedMessage[]> {
    const release = await locks.acquire(ROUTER_KEY, "router", opts.config.runtime.lane_queue_timeout_ms);
    try {
      const stored = await insertMessage(opts.db, { fromAgentId: null, toAgentId: null, content });
      const utterance = messageToTranscriptEntry(stored);
      transcript.ingest(utterance);
      await writeAgentLog(opts.db, {
        agentId: null,
        lane: "router",
        event: "message",
        payload: {
          direction: "receive",
          message_id: utterance.id,
          from_agent_id: null,
          to_agent_id: null,
          content: utterance.content,
          seq: utterance.seq,
        },
      });

      const helpers = laneHelpers(null, "router");
      const sent: RoutedMessage[] = [];
      const deps: StepDeps = {
        agentId: ROUTER_KEY,
        lane: "router",
        wake: new Wake(),
        assemble: helpers.assemble,
        arrivalsSince: (afterSeq: number) => arrivalsSince(transcript, null, afterSeq),
        call: (request: DwarChatRequest) => opts.dwar.complete(request, "dimaag/router"),
        executeTool: async (call: DwarToolUseBlock) => {
          const result = await helpers.exec(call);
          if (call.name === SEND_MESSAGE && !result.isError) {
            sent.push(JSON.parse(result.content) as RoutedMessage);
          }
          return result;
        },
        logResponse: helpers.logResponse,
        logToolResult: helpers.logToolResult,
      };
      for (;;) {
        const assembled = await deps.assemble();
        syncWake(deps, assembled);
        const request = laneRequest(deps, assembled);
        const response = await deps.call(request);
        await deps.logResponse(response);
        if (await runStep(deps, response, () => false)) {
          return sent;
        }
      }
    } finally {
      release();
    }
  }

  function reasoningDeps(agentId: string) {
    return {
      ...stepDeps(agentId, "reasoning"),
      call: (request: DwarChatRequest) => opts.dwar.reason(request, `dimaag/${agentId}`),
      steer,
    };
  }

  function conversationDeps(agentId: string) {
    return {
      ...stepDeps(agentId, "conversation"),
      call: (request: DwarChatRequest) => opts.dwar.converse(request, `dimaag/${agentId}`),
      intents,
    };
  }

  return runtime;
}
