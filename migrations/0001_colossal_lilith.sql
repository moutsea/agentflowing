CREATE TABLE `file_asset` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_asset_key_unique` ON `file_asset` (`key`);--> statement-breakpoint
CREATE INDEX `file_asset_org_created_idx` ON `file_asset` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `file_asset_user_created_idx` ON `file_asset` (`user_id`,`created_at`);