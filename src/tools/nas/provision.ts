import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    node_name: z.string().min(1),
  })
  .strict();

/** Mint a mesh provision bundle via Nas POST /provision. */
export const provision = defineTool({
  name: "nas_provision",
  description:
    "Mint a Headscale preauth credentials bundle for a new Hath device. Returns base64 bundle text for QR / paste provisioning.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      node_name: { type: "string", description: "Mesh node name for the device" },
    },
    required: ["node_name"],
  },
  async handler(ctx, parsed) {
    return nasToolCall(
      () => ctx.nas.provision(parsed.node_name),
      (body) => body,
    );
  },
});
