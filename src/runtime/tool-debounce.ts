/** Per-agent failure backoff for tool execution. */

export type ToolBackoffConfig = {
  /** Wait before the next tool call after a single failure. */
  base_ms: number;
  /** Ceiling on the exponentially growing wait. */
  max_ms: number;
};

/**
 * ToolDebounce paces an agent only when its tool calls fail. Successful calls run
 * back-to-back with no delay, so an agent can drive input as fast as it likes.
 * Each consecutive failure doubles the wait before the next call (base_ms,
 * 2×base_ms, 4×base_ms, …) up to max_ms; the first success clears the streak.
 */
export class ToolDebounce {
  private readonly failuresByAgent = new Map<string, number>();

  constructor(private readonly config: ToolBackoffConfig) {}

  /** delayBeforeNext returns the wait an agent owes before its next tool call. */
  delayBeforeNext(agentId: string): number {
    const failures = this.failuresByAgent.get(agentId) ?? 0;
    if (failures === 0) {
      return 0;
    }
    return Math.min(this.config.max_ms, this.config.base_ms * 2 ** (failures - 1));
  }

  /** record advances the streak: a success clears it, a failure extends it. */
  record(agentId: string, isError: boolean): void {
    if (isError) {
      this.failuresByAgent.set(agentId, (this.failuresByAgent.get(agentId) ?? 0) + 1);
    } else {
      this.failuresByAgent.delete(agentId);
    }
  }
}
