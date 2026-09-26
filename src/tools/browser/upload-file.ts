import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    ref: z.string().min(1),
    paths: z
      .array(z.string().min(1).refine((path) => path.startsWith("/"), "paths must be absolute"))
      .min(1),
  })
  .strict();

/** Attach host files to a file input or the file chooser a ref opens. Intended for workers. */
export const uploadFile = defineTool({
  name: "browser_upload_file",
  description:
    "Attach files from the host to an upload field. ref is the file input itself or the button/drop zone that opens the file chooser (hidden file inputs do not appear in the tree, so use the visible upload control). paths are absolute host paths, read by the browser directly. Returns the attached file names and byte sizes as the page reports them. Refs come from browser_accessibility_tree and go stale after the next snapshot.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id", "ref", "paths"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
      ref: {
        type: "string",
        description: "Ref of a file input, or of the control that opens the file chooser",
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Absolute host paths of the files to attach, in order",
      },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      () => ctx.browsers.uploadFile(parsed.browser_id, parsed.tab_id, parsed.ref, parsed.paths),
      (response) => ({ uploaded: true as const, ref: parsed.ref, files: response.files }),
      (response) => ({
        browser_id: parsed.browser_id,
        tab_id: response.tab_id,
        paths: parsed.paths,
      }),
    );
  },
});
