import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { scheduledMessages } from "../../db/schema.js";
import { toScheduledMessageRecord } from "../../serialize.js";
import { defineTool } from "../types.js";
import { ok } from "../shared.js";

const input = z.object({}).default({});

/** List schedules created by the caller. */
export const listSchedules = defineTool({
  name: "list_schedules",
  description: "List every scheduled message you created, ordered by next run_at.",
  input,
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async handler(ctx) {
    const rows = await ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.fromAgentId, ctx.callerId))
      .orderBy(asc(scheduledMessages.runAt));
    return ok({ schedules: rows.map(toScheduledMessageRecord) });
  },
});
