CREATE INDEX `agent_created_by_idx` ON `agent` (`created_by`);--> statement-breakpoint
CREATE INDEX `agent_run_user_idx` ON `agent_run` (`user_id`);--> statement-breakpoint
CREATE INDEX `api_key_created_by_idx` ON `api_key` (`created_by`);--> statement-breakpoint
CREATE INDEX `user_createdAt_idx` ON `user` (`createdAt`);