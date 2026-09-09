import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
  })
  .strict();

/** Kill a Nas browser and drop the in-process CDP connection. Intended for managers. */
export const closeBrowser = defineTool({
  name: "close_browser",
  description: "Destroy a Nas browser by id and drop any local CDP connection to it.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id"],
    properties: {
      browser_id: { type: "number", description: "Browser id from spawn_browser" },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      async () => {
        ctx.browsers.drop(parsed.browser_id);
        await ctx.nas.closeBrowser(parsed.browser_id);
        return { closed: true as const };
      },
      (response) => response,
      { browser_id: parsed.browser_id },
    );
  },
});
