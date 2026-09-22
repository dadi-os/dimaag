/** In-process cache of durable messages. Hydrated from DB on boot; dies with the process. */

export type TranscriptEntry = {
  /** Durable messages.id when loaded from or written to the messages table. */
  id?: string;
  seq: number;
  fromAgentId: string | null;
  toAgentId: string | null;
  content: string;
  createdAt: Date;
};

export class TranscriptStore {
  private counter = 0;
  private readonly inbox = new Map<string, TranscriptEntry[]>();
  private readonly outbox = new Map<string, TranscriptEntry[]>();

  /**
   * Ingest a durable (or test) row into inbox/outbox. Advances the local seq
   * watermark so later appends do not collide when used in unit tests.
   */
  ingest(row: TranscriptEntry): void {
    this.counter = Math.max(this.counter, row.seq);
    if (row.toAgentId !== null) {
      const list = this.inbox.get(row.toAgentId) ?? [];
      list.push(row);
      this.inbox.set(row.toAgentId, list);
    }
    if (row.fromAgentId !== null) {
      const list = this.outbox.get(row.fromAgentId) ?? [];
      list.push(row);
      this.outbox.set(row.fromAgentId, list);
    }
  }

  /**
   * Records one message with a process-local seq. Prefer insertMessage + ingest
   * on the live path; tests may still call append directly.
   */
  append(entry: {
    fromAgentId: string | null;
    toAgentId: string | null;
    content: string;
    id?: string;
  }): TranscriptEntry {
    const row: TranscriptEntry = {
      seq: ++this.counter,
      fromAgentId: entry.fromAgentId,
      toAgentId: entry.toAgentId,
      content: entry.content,
      createdAt: new Date(),
      ...(entry.id !== undefined ? { id: entry.id } : {}),
    };
    this.ingest(row);
    return row;
  }

  /**
   * Every inbound message for this agent plus every outbound message from it,
   * sorted by seq.
   */
  transcriptFor(agentId: string): TranscriptEntry[] {
    const inbound = this.inbox.get(agentId) ?? [];
    const outgoing = this.outbox.get(agentId) ?? [];
    const bySeq = new Map<number, TranscriptEntry>();
    for (const row of inbound) bySeq.set(row.seq, row);
    for (const row of outgoing) bySeq.set(row.seq, row);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
}
