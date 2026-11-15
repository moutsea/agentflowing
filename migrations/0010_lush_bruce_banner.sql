CREATE TABLE `admin_coupon_issuance` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`batch` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_coupon_issuance_actor_key_uidx` ON `admin_coupon_issuance` (`actor_user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `admin_coupon_issuance_status_idx` ON `admin_coupon_issuance` (`status`);