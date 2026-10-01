import type { IntentQueue } from "./intents.js";
import { formatIntentTurn } from "./intents.js";
import { laneRequest, runStep, syncWake, type StepDeps } from "./step.js";

/** Step deps plus the intent queue reasoning's send_message writes to. */
export type ConversationLoopDeps = StepDeps & {
  intents: IntentQueue;
};

/**
 * Conversation-lane loop over the agent's shared wake. It sees exactly what
 * reasoning sees — including reasoning's thinking, tool calls and results — so
 * status it reports comes from what actually happened. Reasoning's send_message
 * intents join the wake as conversation-only turns. A turn with no tool call
 * continues; the only clean exit is the embedded yield tool.
 * Skips the provider call when the visible history is empty or ends on an
 * assistant turn — providers reject those requests, and nothing is waiting —
 * or when nothing it can see has joined the wake since it last yielded, as
 * when several wake-ups queue behind one run that already handled them.
 */
export async function runConversationLoop(deps: ConversationLoopDeps): Promise<void> {
  for (;;) {
    const assembled = await deps.assemble();
    syncWake(deps, assembled);
    const intents = deps.intents.drain(deps.agentId);
    if (intents.length > 0) {
      deps.wake.push({
        message: { role: "user", content: formatIntentTurn(intents) },
        only: "conversation",
      });
    }

    const request = laneRequest(deps, assembled);
    const last = request.messages[request.messages.length - 1];
    if (!last || last.role !== "user" || deps.wake.unchangedSinceYield(deps.lane)) {
      return;
    }

    const response = await deps.call(request);
    await deps.logResponse(response);

    if (await runStep(deps, response, () => false)) {
      return;
    }
  }
}
