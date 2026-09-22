/** Request body / param zod schemas and parse helpers for HTTP routes. */

import { z, type ZodError } from "zod";
import { agentIdSchema } from "../agent-id.js";
import { DimaagError } from "../errors.js";

/** Parse with zod; map failures to `422 invalid_request`. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new DimaagError(422, "invalid_request", formatZod(parsed.error));
  }
  return parsed.data;
}

/** Flatten zod issues into a single semicolon-joined message. */
export function formatZod(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const loc = issue.path.join(".");
      return loc ? `${loc}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

const messageAttachment = z
  .object({
    media_type: z.string().min(1),
    data: z.string().min(1),
    filename: z.string().min(1).optional(),
  })
  .strict();

export const postDadiBody = z
  .object({
    /** May be empty when attachments are present; patched server-side. */
    content: z.string(),
    attachments: z.array(messageAttachment).max(8).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.content.trim().length === 0 && (body.attachments?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content or attachments required",
        path: ["content"],
      });
    }
  });

export const postMessageBody = z
  .object({
    to_agent_id: agentIdSchema,
    /** May be empty when attachments are present; patched server-side. */
    content: z.string(),
    attachments: z.array(messageAttachment).max(8).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.content.trim().length === 0 && (body.attachments?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content or attachments required",
        path: ["content"],
      });
    }
  });

export const idParam = z.object({ id: agentIdSchema }).strict();

export const logsQuery = z
  .object({
    event: z.enum(["thought", "tool_call", "tool_result", "message"]).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

export const agentMessagesQuery = z
  .object({
    since_seq: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().max(500).default(200),
  })
  .strict();
