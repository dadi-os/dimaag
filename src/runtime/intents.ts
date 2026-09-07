/** Reasoning-lane send_message handoff. Conversation drains this before composing. */

export type DispatchIntent = {
  toAgentId: string | null;
  intent: string;
};

export class IntentQueue {
  private readonly items = new Map<string, DispatchIntent[]>();

  append(agentId: string, intent: DispatchIntent): void {
    const list = this.items.get(agentId) ?? [];
    list.push(intent);
    this.items.set(agentId, list);
  }

  drain(agentId: string): DispatchIntent[] {
    const list = this.items.get(agentId) ?? [];
    this.items.delete(agentId);
    return list;
  }

  hasItems(agentId: string): boolean {
    return (this.items.get(agentId) ?? []).length > 0;
  }
}

export function formatIntentTurn(intents: DispatchIntent[]): string {
  const parts = intents.map((item) => {
    const to = item.toAgentId === null ? "null (the user)" : item.toAgentId;
    return `to_agent_id: ${to}\nintent:\n${item.intent}`;
  });
  return `Your reasoning lane asked you to send a message. Call dispatch_message with the composed content.\n\n${parts.join("\n\n")}`;
}
