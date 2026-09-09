import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1),
  })
  .strict();

/** Close a tab. Intended for workers. */
export const closeTab = defineTool({
  name: "close_tab",
  description: "Close a tab by CDP target id.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id", "tab_id"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "CDP target id from list_tabs or new_tab" },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      async () => {
        await ctx.browsers.closeTab(parsed.browser_id, parsed.tab_id);
        return { closed: true as const };
      },
      (response) => response,
      { browser_id: parsed.browser_id, tab_id: parsed.tab_id },
    );
  },
});
