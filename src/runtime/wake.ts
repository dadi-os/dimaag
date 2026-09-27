/**
 * One agent's shared lane history for the current wake.
 *
 * Both lanes read the same record: the transcript frozen when the wake began,
 * then every step either lane took — each model turn whole (thinking, text,
 * tool calls, in provider order) followed by its tool results — plus messages
 * that arrived mid-wake. Nothing is dropped or shortened while the wake lasts.
 * Only two kinds of turn are lane-private: steers (reasoning's instructions)
 * and intents (conversation's delivery requests), because the other lane
 * already sees the tool call that produced them.
 *
 * A wake lasts while any lane run for the agent is queued or running, so a
 * steer from conversation reaches a reasoning run that still sees the steer's
 * call. When the last run releases, the record is dropped and the next wake
 * starts from the transcript alone — prior steps cannot few-shot it.
 */

import type { DwarMessage, Lane } from "../types/domain.js";

/** Neutral user turn recorded after a model turn with no tool call, so the lane keeps going. */
export const CONTINUE_TURN = "[continue]";

/** One entry in a wake: a user or assistant turn, optionally private to one lane. */
export type WakeTurn = {
  message: DwarMessage;
  /** Set when only one lane should see this turn. */
  only?: Lane;
};

/** Wake is one agent's shared lane history for the current wake. */
export class Wake {
  private transcript: DwarMessage[] | null = null;
  private seenThrough = 0;
  private readonly turns: WakeTurn[] = [];

  /** False until the wake's first lane call freezes the transcript. */
  get started(): boolean {
    return this.transcript !== null;
  }

  /** Freeze the transcript the wake begins from. */
  begin(transcript: DwarMessage[], throughSeq: number): void {
    this.transcript = transcript;
    this.seenThrough = throughSeq;
  }

  get throughSeq(): number {
    return this.seenThrough;
  }

  /** Record that transcript entries through `seq` have been folded in. */
  advance(seq: number): void {
    this.seenThrough = seq;
  }

  /** Append turns together, so a model turn and its results are never split by the other lane. */
  push(...turns: WakeTurn[]): void {
    this.turns.push(...turns);
  }

  /** What `lane` sends to its provider: the frozen transcript, then every turn it may see. */
  view(lane: Lane): DwarMessage[] {
    if (this.transcript === null) {
      throw new Error("wake has not begun");
    }
    const visible = this.turns
      .filter((turn) => turn.only === undefined || turn.only === lane)
      .map((turn) => turn.message);
    return [...this.transcript, ...visible];
  }
}

/** WakeStore holds each agent's current wake and how many lane runs keep it alive. */
export class WakeStore {
  private readonly wakes = new Map<string, Wake>();
  private readonly holds = new Map<string, number>();

  /** The agent's current wake, created on first use. */
  get(agentId: string): Wake {
    let wake = this.wakes.get(agentId);
    if (!wake) {
      wake = new Wake();
      this.wakes.set(agentId, wake);
    }
    return wake;
  }

  /**
   * hold keeps the agent's wake alive for one queued or running lane run.
   * The returned release is idempotent; the wake is dropped when the last
   * hold is released.
   */
  hold(agentId: string): () => void {
    this.holds.set(agentId, (this.holds.get(agentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const held = this.holds.get(agentId);
      if (held === undefined) {
        throw new Error(`wake for ${agentId} released without a hold`);
      }
      const left = held - 1;
      if (left > 0) {
        this.holds.set(agentId, left);
        return;
      }
      this.holds.delete(agentId);
      this.wakes.delete(agentId);
    };
  }
}
