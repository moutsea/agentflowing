CREATE TABLE `analytics_visit` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`path` text NOT NULL,
	`visitor_key` text NOT NULL,
	`source` text NOT NULL,
	`source_host` text,
	`campaign` text,
	`medium` text,
	`country` text,
	`device` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `analytics_visit_day_idx` ON `analytics_visit` (`day`);--> statement-breakpoint
CREATE INDEX `analytics_visit_day_source_idx` ON `analytics_visit` (`day`,`source`);--> statement-breakpoint
CREATE INDEX `analytics_visit_day_path_idx` ON `analytics_visit` (`day`,`path`);--> statement-breakpoint
CREATE INDEX `analytics_visit_visitor_day_idx` ON `analytics_visit` (`visitor_key`,`day`);