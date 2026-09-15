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
    tool: "dimaag_spawn_agent",
    usage:
      "When no existing child owns this exact user problem, spawn a thread with a narrow job prompt. Do not do the user's work yourself — spawn, grant, and hand the UUID back.",
  },
  {
    tool: "dimaag_modify_agent",
    usage:
      "Update your own prompt or a direct child's. Set active to false to stop a child you spawned.",
  },
  {
    tool: "dimaag_grant_tool",
    usage:
      "Right after spawning (or when reusing a child that lacks them), grant only the tools that thread needs for the job — e.g. yaad_ingest/yaad_recall for memory facts.",
  },
  {
    tool: "dimaag_revoke_tool",
    usage: "Take a tool back from a child when it no longer needs it.",
  },
  {
    tool: "dimaag_schedule_message",
    usage:
      "When the user wants something to happen later or on a repeating basis (a daily briefing, a reminder, a periodic check), spawn or pick the thread that will do the work, grant it its tools, then schedule the instruction to that thread. Root never does the scheduled work itself.",
  },
  {
    tool: "dimaag_list_schedules",
    usage:
      "When the user asks what is scheduled, or before changing a recurring job so you cancel the right one.",
  },
  {
    tool: "dimaag_cancel_schedule",
    usage:
      "When the user stops or changes something recurring. Cancel the old row before scheduling a replacement.",
  },
  {
    tool: "dimaag_get_logs",
    usage:
      "When you need the agent audit trail (thoughts, tool calls, messages). Not for HTTP/system logs — use nas_get_logs.",
  },
  {
    tool: "yaad_recall",
    usage:
      "For thread agents that need memory. Root reasoning should not use this to answer the user — grant it to the thread instead.",
  },
  {
    tool: "yaad_query",
    usage:
      "For thread agents that need exact lookups. Root reasoning should not use this to answer the user — grant it to the thread instead.",
  },
  {
    tool: "yaad_get_node",
    usage:
      "For thread agents that need node edges. Root reasoning should not use this to answer the user — grant it to the thread instead.",
  },
  {
    tool: "yaad_ingest",
    usage:
      "For thread agents that store facts. Root reasoning must not ingest on the user's behalf — spawn/grant a memory-capable thread and route the message there.",
  },
  {
    tool: "yaad_get_node_history",
    usage:
      "When a thread needs the correction history for one memory node after yaad_get_node or yaad_recall.",
  },
  {
    tool: "yaad_search_history",
    usage:
      "When a thread searches what changed in memory over time (semantic over node_history).",
  },
  {
    tool: "ghar_list_devices",
    usage:
      "When the user asks what is in the house, or before you control a device you have not already looked up this turn.",
  },
  {
    tool: "ghar_get_state",
    usage:
      "When the question is about how long something has held its current value — empty rooms, lights left on — not when they want a history of changes.",
  },
  {
    tool: "ghar_control_device",
    usage:
      "When the user asks you to change a light, switch, or other device. Confirm the device id and capability from ghar_list_devices first if you do not already have them.",
  },
  {
    tool: "ghar_get_device_events",
    usage:
      "When the user asks what happened to a device or why it changed — use cause to separate your earlier actions from someone flipping the wall switch.",
  },
  {
    tool: "chaavi_list_items",
    usage: "When you need to find a vault item id for a site or named secret.",
  },
  {
    tool: "chaavi_fill_login",
    usage:
      "Grant to browser workers that must log into a website; never browser_type a password.",
  },
  {
    tool: "chaavi_with_secret",
    usage:
      "Grant to terminal workers that need a named secret in the environment (notarization, tokens). Never echo the secret.",
  },
  {
    tool: "terminal_spawn",
    usage:
      "When a coding or shell job needs a host terminal — spawn one, then grant terminal_execute_shell / file tools to the worker and put the terminal_id in its prompt or a message.",
  },
  {
    tool: "terminal_list",
    usage: "When you need to see which host terminals are alive and whether any are busy.",
  },
  {
    tool: "terminal_close",
    usage: "When a worker is done and the host terminal should be destroyed.",
  },
  {
    tool: "terminal_execute_shell",
    usage:
      "For workers that run shell commands on a handed-off terminal_id. Not for reading or editing files — use the file tools.",
  },
  {
    tool: "terminal_read",
    usage: "For workers following a still-running command after terminal_execute_shell timed out.",
  },
  {
    tool: "terminal_send_keys",
    usage: "For workers that need to interrupt or answer a prompt in a terminal (e.g. C-c, Enter).",
  },
  {
    tool: "terminal_read_file",
    usage: "For workers that read host files. Paths must be absolute. Nas denies writes to OS and dadiOS runtime trees.",
  },
  {
    tool: "terminal_write_file",
    usage: "For workers that create or overwrite host files.",
  },
  {
    tool: "terminal_edit_file",
    usage:
      "For workers that make exact string replacements in host files. On a match-count error, widen or narrow old_string.",
  },
  {
    tool: "terminal_glob",
    usage: "For workers that need to find files by pattern on the host (absolute paths).",
  },
  {
    tool: "terminal_grep",
    usage: "For workers that search file contents on the host (absolute paths).",
  },
  {
    tool: "browser_spawn",
    usage:
      "When a job needs a real headed browser — spawn one, grant browser tools to the worker, and put browser_id in its prompt or a message.",
  },
  {
    tool: "browser_list",
    usage: "When you need to see which Nas browsers are alive and healthy.",
  },
  {
    tool: "browser_close",
    usage: "When a browser worker is done and the Chromium instance should be destroyed.",
  },
  {
    tool: "browser_list_tabs",
    usage: "For browser workers listing open tabs (tab_id is the CDP target id).",
  },
  {
    tool: "browser_new_tab",
    usage: "For browser workers opening another tab in their browser.",
  },
  {
    tool: "browser_close_tab",
    usage: "For browser workers closing a tab by tab_id.",
  },
  {
    tool: "browser_navigate",
    usage: "For browser workers loading a URL, then usually browser_accessibility_tree.",
  },
  {
    tool: "browser_accessibility_tree",
    usage:
      "For browser workers before browser_click/browser_type/browser_select — refs are only valid until the next snapshot.",
  },
  {
    tool: "browser_click",
    usage: "For browser workers clicking a ref from the latest browser_accessibility_tree.",
  },
  {
    tool: "browser_type",
    usage: "For browser workers filling a field by ref; submit presses Enter.",
  },
  {
    tool: "browser_select",
    usage: "For browser workers choosing a <browser_select> option by value or label via ref.",
  },
  {
    tool: "browser_wait_for",
    usage: "For browser workers waiting on text, a ref, or network idle.",
  },
  {
    tool: "browser_screenshot",
    usage:
      "For browser workers only when a snapshot is not enough (canvas, captcha, visual check). Returns a Dwar description, not pixels.",
  },
  {
    tool: "browser_extract_text",
    usage: "For browser workers reading long page text when a snapshot is noise.",
  },
  {
    tool: "nas_get_status",
    usage: "When you need host/module health or resource samples.",
  },
  {
    tool: "nas_get_logs",
    usage:
      "When diagnosing HTTP/process failures across services. Not agent cognition — use dimaag_get_logs for that.",
  },
  {
    tool: "nas_restart_module",
    usage:
      "When a module must be restarted. Prefer scoped restarts over stack_down. Restarting dimaag ends this process.",
  },
  {
    tool: "nas_pull_updates",
    usage:
      "When the user asks to update modules or the OS. Prefer scope=modules first; check reboot_required after os/all.",
  },
  {
    tool: "nas_stack_up",
    usage: "When bringing the whole app stack up after maintenance.",
  },
  {
    tool: "nas_stack_down",
    usage: "When taking the whole app stack down for maintenance.",
  },
  {
    tool: "nas_provision",
    usage: "When minting a Hath device provision QR/bundle for a named mesh node.",
  },
  {
    tool: "nas_list_clients",
    usage: "When you need mesh node_name values before calling hath_* tools.",
  },
  {
    tool: "hath_get_info",
    usage: "When you need identity/OS details for a specific Hath client.",
  },
  {
    tool: "hath_get_battery",
    usage: "When you need battery level on a Hath client.",
  },
  {
    tool: "hath_get_location",
    usage: "When you need the client's current location.",
  },
  {
    tool: "hath_get_network",
    usage: "When you need mesh/network status on a Hath client.",
  },
  {
    tool: "hath_read_clipboard",
    usage: "When you need the text currently on a Hath client's clipboard.",
  },
  {
    tool: "hath_write_clipboard",
    usage: "When you need to put text on a Hath client's clipboard.",
  },
  {
    tool: "hath_send_file",
    usage: "When you need to save a file into a Hath client's Downloads folder.",
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
