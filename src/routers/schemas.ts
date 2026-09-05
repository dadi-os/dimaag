import { z, type ZodError, type ZodType } from "zod";
import { DimaagError } from "../errors.js";

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new DimaagError(422, "invalid_request", formatZod(parsed.error));
  }
  return parsed.data;
}

export function formatZod(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const loc = issue.path.join(".");
      return loc ? `${loc}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export const postMessageBody = z
  .object({
    to_agent_id: z.string().uuid(),
    content: z.string().min(1),
  })
  .strict();

export const idParam = z.object({ id: z.string().uuid() }).strict();

export const logsQuery = z
  .object({
    event: z.enum(["thought", "tool_call", "tool_result", "message"]).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();
