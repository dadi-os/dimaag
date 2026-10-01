-- Deleting an agent deletes its subtree: its children, and every log, grant,
-- message, and schedule that names any agent in it.

ALTER TABLE "agents" DROP CONSTRAINT "agents_parent_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_logs" DROP CONSTRAINT "agent_logs_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_tools" DROP CONSTRAINT "agent_tools_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_from_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_to_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "scheduled_messages" DROP CONSTRAINT "scheduled_messages_from_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "scheduled_messages" DROP CONSTRAINT "scheduled_messages_to_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
