UPDATE "agents" SET "parent_agent_id" = NULL WHERE "parent_agent_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
DELETE FROM "agent_tools" WHERE "agent_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
DELETE FROM "agent_logs" WHERE "agent_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
DELETE FROM "scheduled_messages" WHERE "from_agent_id" = '00000000-0000-4000-8000-000000000001' OR "to_agent_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
DELETE FROM "agents" WHERE "id" = '00000000-0000-4000-8000-000000000001';
