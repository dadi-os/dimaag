import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z.object({}).strict();

/** List Nas browsers. Intended for managers. */
export const listBrowsers = defineTool({
  name: "list_browsers",
  description:
    "List live Nas browsers (id, display, cdp_url, healthy). healthy false means Xvfb is up but Chromium is not answering CDP.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  async handler(ctx) {
    return browserToolCall(
      () => ctx.nas.listBrowsers(),
      (browsers) => ({
        browsers: browsers.map((b) => ({
          browser_id: b.id,
          display: b.display,
          cdp_url: b.cdp_url,
          healthy: b.healthy,
        })),
      }),
    );
  },
});
