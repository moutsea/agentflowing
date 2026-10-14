CREATE TABLE `notice` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_by` text,
	`deleted_at` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notice_visibility_created_idx` ON `notice` (`is_active`,`deleted_at`,`createdAt`);--> statement-breakpoint
CREATE TABLE `notice_read_status` (
	`notice_id` text NOT NULL,
	`user_id` text NOT NULL,
	`read_at` integer NOT NULL,
	`dismissed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`notice_id`) REFERENCES `notice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notice_read_user_notice_uidx` ON `notice_read_status` (`user_id`,`notice_id`);--> statement-breakpoint
CREATE INDEX `notice_read_notice_idx` ON `notice_read_status` (`notice_id`);