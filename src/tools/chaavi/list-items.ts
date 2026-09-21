import { z } from "zod";
import { defineTool } from "../types.js";
import { chaaviToolCall } from "./call.js";

const kind = z.enum(["login", "note", "secret"]);

const input = z
  .object({
    q: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    kind: kind.optional(),
  })
  .strict();

/** Find vault items (metadata only) via Chaavi `GET /v1/items`. */
export const listItems = defineTool({
  name: "chaavi_list_items",
  description:
    "Find vault items (passwords, logins, notes, secrets, passkeys) by name or site uri. Does not return secrets. hasPasskey is true when chaavi_fill_passkey applies. Call this before chaavi_fill_login, chaavi_fill_passkey, or chaavi_fill_secret when you do not already have the item_id. For a new site account use chaavi_create_login.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      q: { type: "string", description: "Name search" },
      uri: { type: "string", description: "Site uri filter" },
      kind: {
        type: "string",
        enum: ["login", "note", "secret"],
        description: "Only items of this kind",
      },
    },
  },
  async handler(ctx, parsed) {
    const query = {
      ...(parsed.q !== undefined ? { q: parsed.q } : {}),
      ...(parsed.uri !== undefined ? { uri: parsed.uri } : {}),
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
    };
    return chaaviToolCall(
      () => ctx.chaavi.listItems(query),
      (response) => ({
        items: response.items.map((item) => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
          username: item.username,
          uris: item.uris,
          hasPasskey: item.hasPasskey,
        })),
      }),
    );
  },
});
