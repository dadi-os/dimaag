import { z } from "zod";
import { allTools } from "../registry.js";
import { defineTool } from "../types.js";
import { ok } from "../shared.js";

const input = z
  .object({
    prefix: z.string().min(1).optional(),
  })
  .strict();

/**
 * ListTools returns every grantable registry tool (name + description).
 * Managers call this before dimaag_grant_tool when they do not already know
 * the exact tool names for a suite (browser_, chaavi_, terminal_, …).
 */
export const listTools = defineTool({
  name: "dimaag_list_tools",
  description:
    "List every grantable tool in the registry with its name and description. Use this before dimaag_grant_tool when you need exact tool names for a suite (for example chaavi_ for vault login fill, browser_ for page control, terminal_ for shells). Optional prefix filters by name start (e.g. chaavi_, browser_). Embedded lane tools (send_message, dispatch_message, list_agents, yield) are not listed — they are not grantable.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      prefix: {
        type: "string",
        description:
          "Optional name prefix filter, e.g. chaavi_, browser_, terminal_, yaad_, ghar_, hath_, nas_, dimaag_",
      },
    },
    required: [],
  },
  async handler(_ctx, parsed) {
    const prefix = parsed.prefix;
    const tools = allTools()
      .filter((tool) => (prefix === undefined ? true : tool.name.startsWith(prefix)))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return ok({ tools, count: tools.length });
  },
});
