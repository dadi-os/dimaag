ALTER TABLE "messages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "messages" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_logs" DROP CONSTRAINT "agent_logs_event_check";--> statement-breakpoint
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_event_check" CHECK ("agent_logs"."event" IN ('thought', 'tool_call', 'tool_result', 'message'));