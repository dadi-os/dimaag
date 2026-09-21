import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().min(10).optional(),
  })
  .strict();

/** Spawn a Nas Chromium+Xvfb browser. Intended for managers. */
export const spawnBrowser = defineTool({
  name: "browser_spawn",
  description:
    "Start a headed Chromium on its own virtual display via Nas. Pass browser_id to start that id again and keep its profile (cookies and logins). Omit browser_id to allocate the lowest id at or above 10 whose display is down and whose profile has no Chromium data, so the login is fresh. Returns browser_id and cdp_url — hand browser_id to a worker in its system prompt or a message. The worker drives pages over CDP; do not pass coordinates. Fails if that id is already running.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      browser_id: {
        type: "number",
        description:
          "Existing browser id to start again, keeping its profile. Omit to allocate a fresh id with no saved login.",
      },
    },
  },
  async handler(ctx, parsed) {
    const body = parsed.browser_id !== undefined ? { id: parsed.browser_id } : {};
    return browserToolCall(
      async () => {
        const created = await ctx.nas.createBrowser(body);
        ctx.browsers.remember(created.id, created.cdp_url);
        return created;
      },
      (response) => ({ browser_id: response.id, cdp_url: response.cdp_url }),
      (response) => ({ browser_id: response.id }),
    );
  },
});
