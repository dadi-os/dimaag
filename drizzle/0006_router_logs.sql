-- The router is the null identity, as in `messages`: its model turns and tool
-- results log with a null agent_id on the new `router` lane, and Ankur's
-- utterances to the router are stored as null -> null messages.

ALTER TABLE "agent_logs" ALTER COLUMN "agent_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_logs" DROP CONSTRAINT "agent_logs_lane_check";
--> statement-breakpoint
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_lane_check" CHECK ("agent_logs"."lane" IN ('reasoning', 'conversation', 'router'));
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_party_check";
