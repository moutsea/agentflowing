WITH eligible_issuance AS MATERIALIZED (
  SELECT
    id,
    actor_user_id,
    created_at,
    COALESCE(json_extract(request_fingerprint, '$.rate'), 0) * 100 AS rate_bps,
    COALESCE(json_extract(request_fingerprint, '$.count'), 1) AS expected_count,
    COALESCE(json_extract(request_fingerprint, '$.validDays'), 7) AS valid_days,
    json_extract(request_fingerprint, '$.note') AS note,
    COALESCE(json_extract(request_fingerprint, '$.source'), 'admin') AS source
  FROM admin_coupon_issuance
  WHERE status = 'pending' AND json_valid(request_fingerprint)
),
unique_issuance AS MATERIALIZED (
  SELECT e.*
  FROM eligible_issuance AS e
  WHERE (
    SELECT COUNT(*)
    FROM coupon AS c
    WHERE c.created_by = e.actor_user_id
      AND c.discount_rate_bps = e.rate_bps
      AND c.source = e.source
      AND (c.note = e.note OR (c.note IS NULL AND e.note IS NULL))
      AND c.createdAt = e.created_at
      AND c.expires_at = c.createdAt + e.valid_days * 86400
  ) = e.expected_count
    AND NOT EXISTS (
      SELECT 1
      FROM coupon AS linked
      WHERE linked.admin_issuance_id IS NOT NULL
        AND linked.created_by = e.actor_user_id
        AND linked.discount_rate_bps = e.rate_bps
        AND linked.source = e.source
        AND (linked.note = e.note OR (linked.note IS NULL AND e.note IS NULL))
        AND linked.createdAt = e.created_at
        AND linked.expires_at = linked.createdAt + e.valid_days * 86400
    )
    AND (
      SELECT COUNT(*)
      FROM eligible_issuance AS other
      WHERE other.actor_user_id = e.actor_user_id
        AND other.created_at = e.created_at
        AND other.rate_bps = e.rate_bps
        AND other.expected_count = e.expected_count
        AND other.valid_days = e.valid_days
        AND other.source = e.source
        AND (other.note = e.note OR (other.note IS NULL AND e.note IS NULL))
    ) = 1
)
UPDATE coupon AS c
SET admin_issuance_id = (
  SELECT e.id
  FROM unique_issuance AS e
  WHERE c.created_by = e.actor_user_id
    AND c.discount_rate_bps = e.rate_bps
    AND c.source = e.source
    AND (c.note = e.note OR (c.note IS NULL AND e.note IS NULL))
    AND c.createdAt = e.created_at
    AND c.expires_at = c.createdAt + e.valid_days * 86400
)
WHERE c.admin_issuance_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM unique_issuance AS e
    WHERE c.created_by = e.actor_user_id
      AND c.discount_rate_bps = e.rate_bps
      AND c.source = e.source
      AND (c.note = e.note OR (c.note IS NULL AND e.note IS NULL))
      AND c.createdAt = e.created_at
      AND c.expires_at = c.createdAt + e.valid_days * 86400
  );
