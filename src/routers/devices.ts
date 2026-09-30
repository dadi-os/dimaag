/** Device presence heartbeat and command result routes. */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HathError } from "../errors.js";
import type { DeviceCommandResult } from "../runtime/devices.js";

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

/** Register POST /devices/presence and POST /devices/commands/:command_id/result. */
export async function registerDevices(app: FastifyInstance): Promise<void> {
  app.post("/devices/presence", async (request) => {
    const parsed = presenceBody.safeParse(request.body);
    if (!parsed.success) {
      throw new HathError(400, "invalid_request", parsed.error.message);
    }
    const entry = app.runtime.devices.setPresence(parsed.data);
    return entry;
  });

  app.post<{ Params: { command_id: string } }>(
    "/devices/commands/:command_id/result",
    async (request) => {
      const commandId = request.params.command_id;
      if (!commandId) {
        throw new HathError(400, "invalid_request", "command_id is required");
      }
      const parsed = resultBody.safeParse(request.body);
      if (!parsed.success) {
        throw new HathError(400, "invalid_request", parsed.error.message);
      }
      const result: DeviceCommandResult = parsed.data.ok
        ? { ok: true, result: parsed.data.result }
        : {
            ok: false,
            error: parsed.data.error!,
          };
      const accepted = app.runtime.devices.complete(commandId, result);
      if (!accepted) {
        throw new HathError(404, "not_found", `command ${commandId} not found`);
      }
      return { accepted: true };
    },
  );
}
