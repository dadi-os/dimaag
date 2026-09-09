import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { ROOT_DADI_ID } from "../types/domain.js";
import { toolId } from "../tools/sync.js";
import type { Db } from "./client.js";
import { agentTools, agents } from "./schema.js";

/**
 * Idempotent root-Dadi upsert. Prompt tracks prompts/dadi.md on every migrate
 * and every process boot (index calls migrate), so editing the file + tsx restart
 * keeps routing instructions current; other columns are left alone.
 */
export async function seedRootDadi(db: Db, serviceRoot: string): Promise<void> {
  const systemPrompt = readFileSync(join(serviceRoot, "prompts/dadi.md"), "utf8");
  await db
    .insert(agents)
    .values({
      id: ROOT_DADI_ID,
      name: "Dadi",
      systemPrompt,
      parentAgentId: null,
      active: true,
    })
    .onConflictDoUpdate({
      target: agents.id,
      set: { systemPrompt },
    });
}

const DADI_GRANTS: Array<{ tool: string; usage: string }> = [
  {
    tool: "spawn_agent",
    usage:
      "When no existing child owns this exact user problem, spawn a thread with a narrow job prompt. Do not do the user's work yourself — spawn, grant, and hand the UUID back.",
  },
  {
    tool: "modify_agent",
    usage:
      "Update your own prompt or a direct child's. Set active to false to stop a child you spawned.",
  },
  {
    tool: "grant_tool",
    usage:
      "Right after spawning (or when reusing a child that lacks them), grant only the tools that thread needs for the job — e.g. ingest/recall for memory facts.",
  },
  {
    tool: "revoke_tool",
    usage: "Take a tool back from a child when it no longer needs it.",
  },
  {
    tool: "schedule_message",
    usage:
      "When the user wants something to happen later or on a repeating basis (a daily briefing, a reminder, a periodic check), spawn or pick the thread that will do the work, grant it its tools, then schedule the instruction to that thread. Root never does the scheduled work itself.",
  },
  {
    tool: "list_schedules",
    usage:
      "When the user asks what is scheduled, or before changing a recurring job so you cancel the right one.",
  },
  {
    tool: "cancel_schedule",
    usage:
      "When the user stops or changes something recurring. Cancel the old row before scheduling a replacement.",
  },
  {
    tool: "recall",
    usage:
      "For thread agents that need memory. Root reasoning should not use this to answer the user — grant it to the thread instead.",
  },
  {
    tool: "query",
    usage:
      "For thread agents that need exact lookups. Root reasoning should not use this to answer the user — grant it to the thread instead.",
  },
  {
    tool: "get_node",
    usage:
      "For thread agents that need node edges. Root reasoning should not use this to answer the user — grant it to the thread instead.",
  },
  {
    tool: "ingest",
    usage:
      "For thread agents that store facts. Root reasoning must not ingest on the user's behalf — spawn/grant a memory-capable thread and route the message there.",
  },
  {
    tool: "list_devices",
    usage:
      "When the user asks what is in the house, or before you control a device you have not already looked up this turn.",
  },
  {
    tool: "get_state",
    usage:
      "When the question is about how long something has held its current value — empty rooms, lights left on — not when they want a history of changes.",
  },
  {
    tool: "control_device",
    usage:
      "When the user asks you to change a light, switch, or other device. Confirm the device id and capability from list_devices first if you do not already have them.",
  },
  {
    tool: "get_device_events",
    usage:
      "When the user asks what happened to a device or why it changed — use cause to separate your earlier actions from someone flipping the wall switch.",
  },
  {
    tool: "spawn_terminal",
    usage:
      "When a coding or shell job needs a host terminal — spawn one, then grant execute_shell / file tools to the worker and put the terminal_id in its prompt or a message.",
  },
  {
    tool: "list_terminals",
    usage: "When you need to see which host terminals are alive and whether any are busy.",
  },
  {
    tool: "close_terminal",
    usage: "When a worker is done and the host terminal should be destroyed.",
  },
  {
    tool: "execute_shell",
    usage:
      "For workers that run shell commands on a handed-off terminal_id. Not for reading or editing files — use the file tools.",
  },
  {
    tool: "read_terminal",
    usage: "For workers following a still-running command after execute_shell timed out.",
  },
  {
    tool: "send_keys",
    usage: "For workers that need to interrupt or answer a prompt in a terminal (e.g. C-c, Enter).",
  },
  {
    tool: "read_file",
    usage: "For workers that read host files. Paths must be absolute. Nas denies writes to OS and dadiOS runtime trees.",
  },
  {
    tool: "write_file",
    usage: "For workers that create or overwrite host files.",
  },
  {
    tool: "edit_file",
    usage:
      "For workers that make exact string replacements in host files. On a match-count error, widen or narrow old_string.",
  },
  {
    tool: "glob",
    usage: "For workers that need to find files by pattern on the host (absolute paths).",
  },
  {
    tool: "grep",
    usage: "For workers that search file contents on the host (absolute paths).",
  },
  {
    tool: "spawn_browser",
    usage:
      "When a job needs a real headed browser — spawn one, grant browser tools to the worker, and put browser_id in its prompt or a message.",
  },
  {
    tool: "list_browsers",
    usage: "When you need to see which Nas browsers are alive and healthy.",
  },
  {
    tool: "close_browser",
    usage: "When a browser worker is done and the Chromium instance should be destroyed.",
  },
  {
    tool: "list_tabs",
    usage: "For browser workers listing open tabs (tab_id is the CDP target id).",
  },
  {
    tool: "new_tab",
    usage: "For browser workers opening another tab in their browser.",
  },
  {
    tool: "close_tab",
    usage: "For browser workers closing a tab by tab_id.",
  },
  {
    tool: "navigate",
    usage: "For browser workers loading a URL, then usually accessibility_tree.",
  },
  {
    tool: "accessibility_tree",
    usage:
      "For browser workers before click/type/select — refs are only valid until the next snapshot.",
  },
  {
    tool: "click",
    usage: "For browser workers clicking a ref from the latest accessibility_tree.",
  },
  {
    tool: "type",
    usage: "For browser workers filling a field by ref; submit presses Enter.",
  },
  {
    tool: "select",
    usage: "For browser workers choosing a <select> option by value or label via ref.",
  },
  {
    tool: "wait_for",
    usage: "For browser workers waiting on text, a ref, or network idle.",
  },
  {
    tool: "screenshot",
    usage:
      "For browser workers only when a snapshot is not enough (canvas, captcha, visual check). Returns a Dwar description, not pixels.",
  },
  {
    tool: "extract_text",
    usage: "For browser workers reading long page text when a snapshot is noise.",
  },
];

export async function seed(db: Db, config: Config): Promise<void> {
  await seedRootDadi(db, config.serviceRoot);
  for (const grant of DADI_GRANTS) {
    await db
      .insert(agentTools)
      .values({
        agentId: ROOT_DADI_ID,
        toolId: toolId(grant.tool),
        usage: grant.usage,
      })
      .onConflictDoUpdate({
        target: [agentTools.agentId, agentTools.toolId],
        set: { usage: grant.usage },
      });
  }
}
