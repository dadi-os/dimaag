-- Rename the per-model-call log event from `thought` to `response` and fold
-- `tool_call` rows into their `tool_result`: the call's input already lives in
-- the response row's content, so the result row carries the tool name and the
-- call's audit fields, and tool_call rows go away.

ALTER TABLE "agent_logs" DROP CONSTRAINT "agent_logs_event_check";
--> statement-breakpoint
UPDATE "agent_logs" SET "event" = 'response' WHERE "event" = 'thought';
--> statement-breakpoint
UPDATE "agent_logs" AS result
SET "payload" = (call."payload" - 'id' - 'input') || result."payload"
FROM "agent_logs" AS call
WHERE result."event" = 'tool_result'
  AND call."event" = 'tool_call'
  AND call."agent_id" = result."agent_id"
  AND call."payload"->>'id' = result."payload"->>'tool_use_id';
--> statement-breakpoint
DELETE FROM "agent_logs" WHERE "event" = 'tool_call';
--> statement-breakpoint
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_event_check" CHECK ("agent_logs"."event" IN ('response', 'tool_result', 'message'));
