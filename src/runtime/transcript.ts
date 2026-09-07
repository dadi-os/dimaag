/** In-process replacement for the messages table. Dies with the process, same as locks/steer/intents. */

export type TranscriptEntry = {
  seq: number;
  fromAgentId: string | null;
  toAgentId: string | null;
  content: string;
  createdAt: Date;
};

export type RoutedUserMessage = {
  seq: number;
  toAgentId: string;
  content: string;
};

export class TranscriptStore {
  private counter = 0;
  private readonly inbox = new Map<string, TranscriptEntry[]>();
  private readonly outbox = new Map<string, TranscriptEntry[]>();
  /** Root-only: inbound user (from null) seqs already handed to a thread via route_message. */
  private readonly routedUserSeqs = new Map<string, Map<number, RoutedUserMessage>>();

  /** Records one message. Call once per dispatch, from both the sender's and recipient's perspective is handled internally. */
  append(entry: { fromAgentId: string | null; toAgentId: string | null; content: string }): TranscriptEntry {
    const row: TranscriptEntry = { seq: ++this.counter, ...entry, createdAt: new Date() };
    if (entry.toAgentId !== null) {
      const list = this.inbox.get(entry.toAgentId) ?? [];
      list.push(row);
      this.inbox.set(entry.toAgentId, list);
    }
    if (entry.fromAgentId !== null) {
      const list = this.outbox.get(entry.fromAgentId) ?? [];
      list.push(row);
      this.outbox.set(entry.fromAgentId, list);
    }
    return row;
  }

  /**
   * Same computation assembleContext always did: every message this agent received,
   * plus its own outgoing messages to the counterparty of the most recent inbound.
   */
  transcriptFor(agentId: string): TranscriptEntry[] {
    const inbound = this.inbox.get(agentId) ?? [];
    const latest = inbound[inbound.length - 1];
    let outgoing: TranscriptEntry[] = [];
    if (latest) {
      const counterpart = latest.fromAgentId;
      outgoing = (this.outbox.get(agentId) ?? []).filter((row) => row.toAgentId === counterpart);
    }
    const bySeq = new Map<number, TranscriptEntry>();
    for (const row of inbound) bySeq.set(row.seq, row);
    for (const row of outgoing) bySeq.set(row.seq, row);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  /** User inbounds (from_agent_id null) not yet route_message'd onward. */
  unroutedUserMessages(agentId: string): TranscriptEntry[] {
    const routed = this.routedUserSeqs.get(agentId);
    return (this.inbox.get(agentId) ?? []).filter(
      (row) => row.fromAgentId === null && !routed?.has(row.seq),
    );
  }

  routedUserMessages(agentId: string): RoutedUserMessage[] {
    const routed = this.routedUserSeqs.get(agentId);
    if (!routed) return [];
    return [...routed.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * Mark the latest unrouted user inbound whose content matches as routed to a thread.
   * Returns that seq, or null if nothing matched (still delivers; caller may soft-fail audit).
   */
  markUserMessageRouted(
    routerAgentId: string,
    content: string,
    toAgentId: string,
  ): number | null {
    const candidates = this.unroutedUserMessages(routerAgentId);
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const row = candidates[i];
      if (!row || row.content !== content) continue;
      let map = this.routedUserSeqs.get(routerAgentId);
      if (!map) {
        map = new Map();
        this.routedUserSeqs.set(routerAgentId, map);
      }
      map.set(row.seq, { seq: row.seq, toAgentId, content: row.content });
      return row.seq;
    }
    return null;
  }
}
