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
import { getLogs as dimaagGetLogs } from "./dimaag/get-logs.js";
import { listDevices } from "./ghar/list-devices.js";
import { getState } from "./ghar/get-state.js";
import { controlDevice } from "./ghar/control-device.js";
import { getDeviceEvents } from "./ghar/get-device-events.js";
import { listItems } from "./chaavi/list-items.js";
import { fillLogin } from "./chaavi/fill-login.js";
import { withSecret } from "./chaavi/with-secret.js";
import { getStatus as nasGetStatus } from "./nas/get-status.js";
import { getLogs as nasGetLogs } from "./nas/get-logs.js";
import { restartModule } from "./nas/restart-module.js";
import { pullUpdates } from "./nas/pull-updates.js";
import { stackUp } from "./nas/stack-up.js";
import { stackDown } from "./nas/stack-down.js";
import { provision } from "./nas/provision.js";
import { listClients } from "./nas/list-clients.js";
import { getInfo as hathGetInfo } from "./hath/get-info.js";
import { getBattery as hathGetBattery } from "./hath/get-battery.js";
import { getLocation as hathGetLocation } from "./hath/get-location.js";
import { getNetwork as hathGetNetwork } from "./hath/get-network.js";
import { readClipboard as hathReadClipboard } from "./hath/read-clipboard.js";
import { writeClipboard as hathWriteClipboard } from "./hath/write-clipboard.js";
import { sendFile as hathSendFile } from "./hath/send-file.js";
import { closeTerminal } from "./terminal/close-terminal.js";
import { editFile } from "./terminal/edit-file.js";
import { executeShell } from "./terminal/execute-shell.js";
import { globFiles } from "./terminal/glob.js";
import { grepFiles } from "./terminal/grep.js";
import { listTerminals } from "./terminal/list-terminals.js";
import { readFile } from "./terminal/read-file.js";
import { readTerminal } from "./terminal/read-terminal.js";
import { sendKeys } from "./terminal/send-keys.js";
import { spawnTerminal } from "./terminal/spawn-terminal.js";
import { writeFile } from "./terminal/write-file.js";
import { recall } from "./yaad/recall.js";
import { query } from "./yaad/query.js";
import { getNode } from "./yaad/get-node.js";
import { ingest } from "./yaad/ingest.js";
import { getNodeHistory } from "./yaad/get-node-history.js";
import { searchHistory } from "./yaad/search-history.js";

/**
 * Every non-embedded tool. Embedded lane plumbing (send_message, dispatch_message,
 * steer_reasoning, yield) is deliberately NOT here — those are not grantable and
 * never appear in the tools table.
 */
const definitions = [
  spawnAgent,
  modifyAgent,
  grantTool,
  revokeTool,
  scheduleMessage,
  listSchedules,
  cancelSchedule,
  dimaagGetLogs,
  recall,
  query,
  getNode,
  ingest,
  getNodeHistory,
  searchHistory,
  listDevices,
  getState,
  controlDevice,
  getDeviceEvents,
  listItems,
  fillLogin,
  withSecret,
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
  nasGetStatus,
  nasGetLogs,
  restartModule,
  pullUpdates,
  stackUp,
  stackDown,
  provision,
  listClients,
  hathGetInfo,
  hathGetBattery,
  hathGetLocation,
  hathGetNetwork,
  hathReadClipboard,
  hathWriteClipboard,
  hathSendFile,
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
