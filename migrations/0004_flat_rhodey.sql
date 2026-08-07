CREATE INDEX `agent_run_status_started_idx` ON `agent_run` (`status`,`started_at`);
--> statement-breakpoint
DROP TRIGGER `credit_ledger_apply_entry`;
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
		`lifetime_spent` = MAX(0, `lifetime_spent` + CASE
			WHEN NEW.`type` = 'spend' AND NEW.`delta` < 0
			THEN -NEW.`delta`
			WHEN NEW.`type` = 'refund' AND NEW.`delta` > 0
			THEN -NEW.`delta`
			ELSE 0
		END),
		`updated_at` = unixepoch()
	WHERE `organization_id` = NEW.`organization_id`;
END;
--> statement-breakpoint
UPDATE `credit_account`
SET `lifetime_granted` = COALESCE((
	SELECT SUM(`credit_ledger`.`delta`)
	FROM `credit_ledger`
	WHERE `credit_ledger`.`organization_id` = `credit_account`.`organization_id`
		AND `credit_ledger`.`type` IN ('grant', 'adjustment')
		AND `credit_ledger`.`delta` > 0
), 0);
