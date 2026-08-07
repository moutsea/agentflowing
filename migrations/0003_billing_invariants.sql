CREATE TRIGGER `credit_account_create_for_organization`
AFTER INSERT ON `organization`
BEGIN
	INSERT OR IGNORE INTO `credit_account`
		(`organization_id`, `balance`, `lifetime_granted`, `lifetime_spent`, `updated_at`)
	VALUES (NEW.`id`, 0, 0, 0, unixepoch());
END;
--> statement-breakpoint
INSERT OR IGNORE INTO `credit_account`
	(`organization_id`, `balance`, `lifetime_granted`, `lifetime_spent`, `updated_at`)
SELECT `id`, 0, 0, 0, unixepoch() FROM `organization`;
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
			WHEN NEW.`type` = 'grant' AND NEW.`delta` > 0
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
SET `lifetime_spent` = MAX(0, COALESCE((
	SELECT SUM(CASE
		WHEN `credit_ledger`.`type` = 'spend' AND `credit_ledger`.`delta` < 0
		THEN -`credit_ledger`.`delta`
		WHEN `credit_ledger`.`type` = 'refund' AND `credit_ledger`.`delta` > 0
		THEN -`credit_ledger`.`delta`
		ELSE 0
	END)
	FROM `credit_ledger`
	WHERE `credit_ledger`.`organization_id` = `credit_account`.`organization_id`
), 0));
