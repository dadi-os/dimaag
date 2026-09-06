import type { Lane } from "../types/domain.js";

export type RuntimeEvent =
  | {
      type: "message";
      agent_id: string;
      from_agent_id: string | null;
      to_agent_id: string | null;
      content: string;
      seq: number;
      at: string;
    }
  | { type: "lane_started"; agent_id: string; lane: Lane; at: string }
  | { type: "lane_finished"; agent_id: string; lane: Lane; at: string }
  | { type: "agent_spawned"; agent_id: string; parent_agent_id: string; name: string; at: string }
  | { type: "agent_modified"; agent_id: string; active: boolean; at: string };

type Listener = (event: RuntimeEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never take down a lane run.
      }
    }
  }
}
