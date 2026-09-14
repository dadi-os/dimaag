/** Hath presence heartbeat and command result routes. */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DimaagError } from "../errors.js";
import type { HathCommandResult } from "../runtime/hath.js";

const presenceBody = z
  .object({
    node_name: z.string().min(1),
    platform: z.string().min(1),
    app_version: z.string().min(1),
  })
  .strict();

const resultBody = z
  .object({
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        type: z.string().min(1),
        message: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.ok && body.result === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "result is required when ok is true",
        path: ["result"],
      });
    }
    if (!body.ok && body.error === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "error is required when ok is false",
        path: ["error"],
      });
    }
  });

/** Register POST /hath/presence and POST /hath/commands/:command_id/result. */
export async function registerHath(app: FastifyInstance): Promise<void> {
  app.post("/hath/presence", async (request) => {
    const parsed = presenceBody.safeParse(request.body);
    if (!parsed.success) {
      throw new DimaagError(400, "invalid_request", parsed.error.message);
    }
    const entry = app.runtime.hath.setPresence(parsed.data);
    return entry;
  });

  app.post<{ Params: { command_id: string } }>(
    "/hath/commands/:command_id/result",
    async (request) => {
      const commandId = request.params.command_id;
      if (!commandId) {
        throw new DimaagError(400, "invalid_request", "command_id is required");
      }
      const parsed = resultBody.safeParse(request.body);
      if (!parsed.success) {
        throw new DimaagError(400, "invalid_request", parsed.error.message);
      }
      const result: HathCommandResult = parsed.data.ok
        ? { ok: true, result: parsed.data.result }
        : {
            ok: false,
            error: parsed.data.error!,
          };
      const accepted = app.runtime.hath.complete(commandId, result);
      if (!accepted) {
        throw new DimaagError(404, "not_found", `command ${commandId} not found`);
      }
      return { accepted: true };
    },
  );
}
