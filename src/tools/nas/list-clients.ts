import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z.object({}).strict();

/** List Headscale mesh clients via Nas GET /clients. */
export const listClients = defineTool({
  name: "nas_list_clients",
  description:
    "List mesh clients (Hath devices and the box node) with online status and last_seen from Headscale. Call this to discover node_name values before hath_* tools. online means the node is on the mesh, not that the Hath app is foregrounded.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  async handler(ctx) {
    return nasToolCall(
      () => ctx.nas.listClients(),
      (body) => body,
    );
  },
});
