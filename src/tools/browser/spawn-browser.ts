import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z.object({}).strict();

/** Spawn a Nas Chromium+Xvfb browser. Intended for managers. */
export const spawnBrowser = defineTool({
  name: "spawn_browser",
  description:
    "Start a headed Chromium on its own virtual display via Nas. Returns browser_id and cdp_url — hand browser_id to a worker in its system prompt or a message. The worker drives pages over CDP; do not pass coordinates.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  async handler(ctx) {
    return browserToolCall(
      async () => {
        const created = await ctx.nas.createBrowser();
        ctx.browsers.remember(created.id, created.cdp_url);
        return created;
      },
      (response) => ({ browser_id: response.id, cdp_url: response.cdp_url }),
      (response) => ({ browser_id: response.id }),
    );
  },
});
