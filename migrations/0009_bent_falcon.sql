CREATE TABLE `coupon` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`discount_rate_bps` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` integer NOT NULL,
	`reservation_id` text,
	`reserved_by_user_id` text,
	`reserved_organization_id` text,
	`reserved_at` integer,
	`reservation_expires_at` integer,
	`redeemed_by_user_id` text,
	`redeemed_organization_id` text,
	`redeemed_at` integer,
	`revoked_at` integer,
	`note` text,
	`source` text DEFAULT 'admin' NOT NULL,
	`created_by` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`reserved_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reserved_organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`redeemed_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`redeemed_organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "coupon_discount_rate_bps_check" CHECK(typeof("coupon"."discount_rate_bps") = 'integer' AND "coupon"."discount_rate_bps" BETWEEN 1 AND 5000),
	CONSTRAINT "coupon_expires_at_check" CHECK("coupon"."expires_at" > "coupon"."createdAt"),
	CONSTRAINT "coupon_reservation_window_check" CHECK("coupon"."reservation_expires_at" IS NULL OR ("coupon"."reserved_at" IS NOT NULL AND "coupon"."reservation_expires_at" > "coupon"."reserved_at")),
	CONSTRAINT "coupon_redeemed_at_check" CHECK("coupon"."redeemed_at" IS NULL OR "coupon"."redeemed_at" >= "coupon"."createdAt")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coupon_code_uidx` ON `coupon` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `coupon_reservation_id_uidx` ON `coupon` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `coupon_status_expires_idx` ON `coupon` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `coupon_reservation_expires_idx` ON `coupon` (`reservation_expires_at`);--> statement-breakpoint
CREATE TABLE `redemption_code` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`credits` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_by_user_id` text,
	`redeemed_organization_id` text,
	`redeemed_at` integer,
	`revoked_at` integer,
	`note` text,
	`source` text DEFAULT 'admin' NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`batch_index` integer NOT NULL,
	`created_by` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`redeemed_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`redeemed_organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "redemption_code_credits_check" CHECK(typeof("redemption_code"."credits") = 'integer' AND "redemption_code"."credits" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "redemption_code_batch_index_check" CHECK(typeof("redemption_code"."batch_index") = 'integer' AND "redemption_code"."batch_index" >= 0),
	CONSTRAINT "redemption_code_expires_at_check" CHECK("redemption_code"."expires_at" > "redemption_code"."createdAt"),
	CONSTRAINT "redemption_code_redeemed_at_check" CHECK("redemption_code"."redeemed_at" IS NULL OR "redemption_code"."redeemed_at" >= "redemption_code"."createdAt")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `redemption_code_code_uidx` ON `redemption_code` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `redemption_code_idempotency_batch_uidx` ON `redemption_code` (`idempotency_key`,`batch_index`);--> statement-breakpoint
CREATE INDEX `redemption_code_created_at_idx` ON `redemption_code` (`createdAt`);--> statement-breakpoint
CREATE INDEX `redemption_code_expires_at_idx` ON `redemption_code` (`expires_at`);--> statement-breakpoint
ALTER TABLE `order` ADD `coupon_id` text REFERENCES coupon(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `order` ADD `coupon_code` text;--> statement-breakpoint
ALTER TABLE `order` ADD `base_amount` integer;--> statement-breakpoint
ALTER TABLE `order` ADD `discount_amount` integer;--> statement-breakpoint
ALTER TABLE `order` ADD `discount_rate_bps` integer;--> statement-breakpoint
ALTER TABLE `order` ADD `coupon_reservation_id` text;