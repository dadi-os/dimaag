import type { ToolDefinition } from "./types.js";
import { accessibilityTree } from "./browser/accessibility-tree.js";
import { click } from "./browser/click.js";
import { closeBrowser } from "./browser/close-browser.js";
import { closeTab } from "./browser/close-tab.js";
import { extractText } from "./browser/extract-text.js";
import { listBrowsers } from "./browser/list-browsers.js";
import { listTabs } from "./browser/list-tabs.js";
import { navigate } from "./browser/navigate.js";
import { newTab } from "./browser/new-tab.js";
import { screenshot } from "./browser/screenshot.js";
import { selectOption } from "./browser/select.js";
import { spawnBrowser } from "./browser/spawn-browser.js";
import { typeText } from "./browser/type.js";
import { waitFor } from "./browser/wait-for.js";
import { spawnAgent } from "./dimaag/spawn-agent.js";
import { modifyAgent } from "./dimaag/modify-agent.js";
import { grantTool } from "./dimaag/grant-tool.js";
import { revokeTool } from "./dimaag/revoke-tool.js";
import { scheduleMessage } from "./dimaag/schedule-message.js";
import { listSchedules } from "./dimaag/list-schedules.js";
import { cancelSchedule } from "./dimaag/cancel-schedule.js";
import { listDevices } from "./ghar/list-devices.js";
import { getState } from "./ghar/get-state.js";
import { controlDevice } from "./ghar/control-device.js";
import { getDeviceEvents } from "./ghar/get-device-events.js";
import { closeTerminal } from "./nas/close-terminal.js";
import { editFile } from "./nas/edit-file.js";
import { executeShell } from "./nas/execute-shell.js";
import { globFiles } from "./nas/glob.js";
import { grepFiles } from "./nas/grep.js";
import { listTerminals } from "./nas/list-terminals.js";
import { readFile } from "./nas/read-file.js";
import { readTerminal } from "./nas/read-terminal.js";
import { sendKeys } from "./nas/send-keys.js";
import { spawnTerminal } from "./nas/spawn-terminal.js";
import { writeFile } from "./nas/write-file.js";
import { recall } from "./yaad/recall.js";
import { query } from "./yaad/query.js";
import { getNode } from "./yaad/get-node.js";
import { ingest } from "./yaad/ingest.js";

/**
 * Every non-embedded tool. Embedded lane plumbing (send_message, dispatch_message,
 * route_message, steer_reasoning, yield) is deliberately NOT here — those are not
 * grantable and never appear in the tools table.
 */
const definitions = [
  spawnAgent,
  modifyAgent,
  grantTool,
  revokeTool,
  scheduleMessage,
  listSchedules,
  cancelSchedule,
  recall,
  query,
  getNode,
  ingest,
  listDevices,
  getState,
  controlDevice,
  getDeviceEvents,
  spawnTerminal,
  listTerminals,
  closeTerminal,
  executeShell,
  readTerminal,
  sendKeys,
  readFile,
  writeFile,
  editFile,
  globFiles,
  grepFiles,
  spawnBrowser,
  listBrowsers,
  closeBrowser,
  listTabs,
  newTab,
  closeTab,
  navigate,
  accessibilityTree,
  click,
  typeText,
  selectOption,
  waitFor,
  screenshot,
  extractText,
] as unknown as ToolDefinition[];

const byName = new Map<string, ToolDefinition>();
for (const definition of definitions) {
  if (byName.has(definition.name)) {
    throw new Error(`duplicate tool name in registry: ${definition.name}`);
  }
  byName.set(definition.name, definition);
}

export function allTools(): ToolDefinition[] {
  return definitions;
}

export function findTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}
