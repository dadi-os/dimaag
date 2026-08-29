/** Per-agent in-memory steer instructions. Dies with the process. */

export class SteerQueue {
  private readonly items = new Map<string, string[]>();

  append(agentId: string, instruction: string): void {
    const list = this.items.get(agentId) ?? [];
    list.push(instruction);
    this.items.set(agentId, list);
  }

  drain(agentId: string): string[] {
    const list = this.items.get(agentId) ?? [];
    this.items.delete(agentId);
    return list;
  }

  hasItems(agentId: string): boolean {
    const list = this.items.get(agentId);
    return Boolean(list && list.length > 0);
  }
}

export const STEER_TURN_PREFIX = "Steering instructions from your conversation lane:";

export function formatSteerTurn(instructions: string[]): string {
  const lines = instructions.map((item, index) => `${index + 1}. ${item}`);
  return `${STEER_TURN_PREFIX}\n${lines.join("\n")}`;
}
