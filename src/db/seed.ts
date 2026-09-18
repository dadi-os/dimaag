import { agentTools } from "./schema.js";
import { toolId } from "../tools/sync.js";
import type { Db } from "./client.js";

const WORKER_CATALOG: Array<{ tool: string; usage: string }> = [
  {
    tool: "yaad_recall",
    usage: "Semantic search when you need what you know about a topic.",
  },
  {
    tool: "yaad_query",
    usage: "Exact lookups by dates, names, or filters.",
  },
  {
    tool: "yaad_get_node",
    usage: "Load one memory node and its edges.",
  },
  {
    tool: "yaad_ingest",
    usage: "Store a fact the user asked you to remember.",
  },
  {
    tool: "yaad_get_node_history",
    usage: "Correction history for one memory node.",
  },
  {
    tool: "yaad_search_history",
    usage: "Semantic search over what changed in memory.",
  },
  {
    tool: "ghar_list_devices",
    usage: "What is in the house, or before you control a device you have not looked up.",
  },
  {
    tool: "ghar_get_state",
    usage: "How long something has held its current value — empty rooms, lights left on.",
  },
  {
    tool: "ghar_control_device",
    usage: "Change a light, switch, or other device. Confirm the id from ghar_list_devices first.",
  },
  {
    tool: "ghar_get_device_events",
    usage: "What happened to a device and why it changed.",
  },
  {
    tool: "chaavi_list_items",
    usage: "Find a vault item id by name or site uri (no secrets).",
  },
  {
    tool: "chaavi_fill_login",
    usage: "Type a login into a Nas browser. Never browser_type a password.",
  },
  {
    tool: "chaavi_with_secret",
    usage: "Run a host command with a named secret in env_name. Never echo the secret.",
  },
  {
    tool: "terminal_spawn",
    usage: "Create a host terminal for a coding or shell job.",
  },
  {
    tool: "terminal_list",
    usage: "See which host terminals are alive and whether any are busy.",
  },
  {
    tool: "terminal_close",
    usage: "Destroy a host terminal when the job is done.",
  },
  {
    tool: "terminal_execute_shell",
    usage: "Run a shell command on a terminal_id. Not for reading or editing files.",
  },
  {
    tool: "terminal_read",
    usage: "Follow a still-running command after terminal_execute_shell timed out.",
  },
  {
    tool: "terminal_send_keys",
    usage: "Interrupt or answer a prompt in a terminal (e.g. C-c, Enter).",
  },
  {
    tool: "terminal_read_file",
    usage: "Read host files. Paths must be absolute.",
  },
  {
    tool: "terminal_write_file",
    usage: "Create or overwrite host files.",
  },
  {
    tool: "terminal_edit_file",
    usage: "Exact string replacements in host files.",
  },
  {
    tool: "terminal_glob",
    usage: "Find files by pattern on the host (absolute paths).",
  },
  {
    tool: "terminal_grep",
    usage: "Search file contents on the host (absolute paths).",
  },
  {
    tool: "browser_spawn",
    usage: "Open a headed Nas browser for a web job.",
  },
  {
    tool: "browser_list",
    usage: "See which Nas browsers are alive.",
  },
  {
    tool: "browser_close",
    usage: "Destroy a Nas browser when the job is done.",
  },
  {
    tool: "browser_list_tabs",
    usage: "List open tabs (tab_id is the CDP target id).",
  },
  {
    tool: "browser_new_tab",
    usage: "Open another tab in this browser.",
  },
  {
    tool: "browser_close_tab",
    usage: "Close a tab by tab_id.",
  },
  {
    tool: "browser_navigate",
    usage: "Load a URL, then usually browser_accessibility_tree.",
  },
  {
    tool: "browser_accessibility_tree",
    usage: "Snapshot before click/type/select. Refs are valid only until the next snapshot.",
  },
  {
    tool: "browser_click",
    usage: "Click a ref from the latest browser_accessibility_tree.",
  },
  {
    tool: "browser_type",
    usage: "Fill a field by ref; submit presses Enter.",
  },
  {
    tool: "browser_select",
    usage: "Choose a select option by value or label via ref.",
  },
  {
    tool: "browser_wait_for",
    usage: "Wait on text, a ref, or network idle.",
  },
  {
    tool: "browser_screenshot",
    usage: "When a snapshot is not enough (canvas, captcha, visual check). Returns a Dwar description.",
  },
  {
    tool: "browser_extract_text",
    usage: "Read long page text when a snapshot is noise.",
  },
  {
    tool: "nas_get_status",
    usage: "Host/module health or resource samples.",
  },
  {
    tool: "nas_get_logs",
    usage: "HTTP/process failures across services. Not agent cognition — use dimaag_get_logs.",
  },
  {
    tool: "nas_list_clients",
    usage: "Mesh node_name values before calling hath_* tools.",
  },
  {
    tool: "hath_get_info",
    usage: "Identity/OS details for a specific Hath client.",
  },
  {
    tool: "hath_get_battery",
    usage: "Battery level on a Hath client.",
  },
  {
    tool: "hath_get_location",
    usage: "The client's current location.",
  },
  {
    tool: "hath_get_network",
    usage: "Mesh/network status on a Hath client.",
  },
  {
    tool: "hath_read_clipboard",
    usage: "Text currently on a Hath client's clipboard.",
  },
  {
    tool: "hath_write_clipboard",
    usage: "Put text on a Hath client's clipboard.",
  },
  {
    tool: "hath_send_file",
    usage: "Save a file into a Hath client's Downloads folder.",
  },
  {
    tool: "dimaag_schedule_message",
    usage:
      "Deliver a message to another agent later, optionally repeating. You cannot schedule a message to yourself.",
  },
  {
    tool: "dimaag_list_schedules",
    usage: "List schedules you created.",
  },
  {
    tool: "dimaag_cancel_schedule",
    usage: "Cancel a schedule you created.",
  },
  {
    tool: "dimaag_get_logs",
    usage: "Agent audit trail (thoughts, tool calls, messages).",
  },
];

/**
 * Grant the worker catalog to a Dadi-spawned top-level thread.
 * Agent-spawned children still start empty and take parent grants.
 */
export async function applyWorkerCatalog(db: Db, agentId: string): Promise<void> {
  for (const grant of WORKER_CATALOG) {
    await db
      .insert(agentTools)
      .values({
        agentId,
        toolId: toolId(grant.tool),
        usage: grant.usage,
      })
      .onConflictDoUpdate({
        target: [agentTools.agentId, agentTools.toolId],
        set: { usage: grant.usage },
      });
  }
}

/** Tool names written by `applyWorkerCatalog`. */
export function workerCatalogNames(): string[] {
  return WORKER_CATALOG.map((grant) => grant.tool);
}
