ALTER TABLE `coupon` ADD `admin_issuance_id` text REFERENCES admin_coupon_issuance(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `coupon_admin_issuance_idx` ON `coupon` (`admin_issuance_id`);
