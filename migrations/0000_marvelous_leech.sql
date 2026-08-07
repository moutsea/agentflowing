CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`userId`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_account_uidx` ON `account` (`providerId`,`accountId`);--> statement-breakpoint
CREATE TABLE `agent` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`system_prompt` text NOT NULL,
	`model` text NOT NULL,
	`credit_cost` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`visibility` text DEFAULT 'workspace' NOT NULL,
	`created_by` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_org_slug_uidx` ON `agent` (`organization_id`,`slug`);--> statement-breakpoint
CREATE INDEX `agent_org_status_idx` ON `agent` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `agent_run` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`chat_id` text,
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`credits` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`error` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_org_idempotency_uidx` ON `agent_run` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `agent_run_org_started_idx` ON `agent_run` (`organization_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_key_hash_uidx` ON `api_key` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_key_org_idx` ON `api_key` (`organization_id`);--> statement-breakpoint
CREATE TABLE `chat` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text DEFAULT 'New conversation' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_org_updated_idx` ON `chat` (`organization_id`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `chat_user_updated_idx` ON `chat` (`user_id`,`updatedAt`);--> statement-breakpoint
CREATE TABLE `credit_account` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`lifetime_granted` integer DEFAULT 0 NOT NULL,
	`lifetime_spent` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`delta` integer NOT NULL,
	`type` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`description` text NOT NULL,
	`reference_type` text,
	`reference_id` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_ledger_org_idempotency_uidx` ON `credit_ledger` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `credit_ledger_org_created_idx` ON `credit_ledger` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`inviterId` text NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviterId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitation_organizationId_idx` ON `invitation` (`organizationId`);--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`userId` text NOT NULL,
	`role` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_organizationId_idx` ON `member` (`organizationId`);--> statement-breakpoint
CREATE INDEX `member_userId_idx` ON `member` (`userId`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_org_user_uidx` ON `member` (`organizationId`,`userId`);--> statement-breakpoint
CREATE TABLE `order` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_session_id` text,
	`kind` text NOT NULL,
	`plan_id` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`credits` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`paid_at` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_provider_session_uidx` ON `order` (`provider`,`provider_session_id`);--> statement-breakpoint
CREATE INDEX `order_org_created_idx` ON `order` (`organization_id`,`createdAt`);--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE TABLE `payment_event` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`payload_hash` text NOT NULL,
	`error` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_event_provider_event_uidx` ON `payment_event` (`provider`,`provider_event_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	`activeOrganizationId` text,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`userId`);--> statement-breakpoint
CREATE TABLE `subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_customer_id` text,
	`provider_subscription_id` text NOT NULL,
	`provider_price_id` text,
	`plan_id` text NOT NULL,
	`status` text NOT NULL,
	`current_period_start` integer,
	`current_period_end` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`canceled_at` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_provider_id_uidx` ON `subscription` (`provider`,`provider_subscription_id`);--> statement-breakpoint
CREATE INDEX `subscription_org_status_idx` ON `subscription` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL,
	`image` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);
--> statement-breakpoint
CREATE TRIGGER `credit_ledger_require_account`
BEFORE INSERT ON `credit_ledger`
WHEN NOT EXISTS (
	SELECT 1 FROM `credit_account`
	WHERE `organization_id` = NEW.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'CREDIT_ACCOUNT_NOT_FOUND');
END;
--> statement-breakpoint
CREATE TRIGGER `credit_ledger_prevent_overdraft`
BEFORE INSERT ON `credit_ledger`
WHEN NEW.`delta` < 0 AND (
	SELECT `balance` + NEW.`delta`
	FROM `credit_account`
	WHERE `organization_id` = NEW.`organization_id`
) < 0
BEGIN
	SELECT RAISE(ABORT, 'INSUFFICIENT_CREDITS');
END;
--> statement-breakpoint
CREATE TRIGGER `credit_ledger_apply_entry`
AFTER INSERT ON `credit_ledger`
BEGIN
	UPDATE `credit_account`
	SET
		`balance` = `balance` + NEW.`delta`,
		`lifetime_granted` = `lifetime_granted` + CASE
			WHEN NEW.`type` IN ('grant', 'adjustment') AND NEW.`delta` > 0
			THEN NEW.`delta`
			ELSE 0
		END,
		`lifetime_spent` = `lifetime_spent` + CASE
			WHEN NEW.`type` = 'spend' AND NEW.`delta` < 0
			THEN -NEW.`delta`
			ELSE 0
		END,
		`updated_at` = unixepoch()
	WHERE `organization_id` = NEW.`organization_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `credit_ledger_immutable_update`
BEFORE UPDATE ON `credit_ledger`
BEGIN
	SELECT RAISE(ABORT, 'CREDIT_LEDGER_IS_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER `credit_ledger_immutable_delete`
BEFORE DELETE ON `credit_ledger`
BEGIN
	SELECT RAISE(ABORT, 'CREDIT_LEDGER_IS_IMMUTABLE');
END;
