import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { grantCredits } from "../src/server/modules/billing/service";

const migrationFiles = import.meta.glob("../migrations/*.sql", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const migrations = Object.entries(migrationFiles)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, sql]) => ({
    name: path.split("/").at(-1) ?? path,
    queries: sql
      .split("--> statement-breakpoint")
      .map((query) => query.trim())
      .filter(Boolean),
  }));

beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
});

async function seedOrganization() {
  const suffix = crypto.randomUUID();
  const organizationId = `grant-org-${suffix}`;
  await env.DB.prepare(
    `INSERT INTO organization (id, name, slug, createdAt)
     VALUES (?, 'Grant test workspace', ?, unixepoch())`,
  )
    .bind(organizationId, `grant-test-${suffix}`)
    .run();
  return { organizationId, suffix };
}

describe("grantCredits", () => {
  it("replays one organization/key as one ledger entry and returns committed balance", async () => {
    const { organizationId } = await seedOrganization();
    const first = await grantCredits({
      env,
      organizationId,
      credits: 7,
      idempotencyKey: "test:grant:replay",
      description: "Test grant",
      referenceType: "test",
      referenceId: organizationId,
    });
    const replay = await grantCredits({
      env,
      organizationId,
      credits: 99,
      idempotencyKey: "test:grant:replay",
      description: "Changed replay payload",
    });

    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.ledgerId).toBe(first.ledgerId);
    expect(replay.balance).toBe(7);
    expect(replay.account.balance).toBe(7);
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM credit_ledger
         WHERE organization_id = ? AND idempotency_key = ? AND type = 'grant'`,
      )
        .bind(organizationId, "test:grant:replay")
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("rolls back a claim when the grant fails and leaves no ledger entry", async () => {
    const { organizationId, suffix } = await seedOrganization();
    const codeId = `code-${suffix}`;
    await env.DB.prepare(
      `INSERT INTO redemption_code
       (id, code, credits, expires_at, idempotency_key, request_fingerprint, batch_index,
        createdAt, updatedAt)
       VALUES (?, ?, 5, unixepoch() + 3600, ?, ?, 0, unixepoch(), unixepoch())`,
    )
      .bind(
        codeId,
        `RC${suffix.replaceAll("-", "").slice(0, 12)}`,
        `issue:${suffix}`,
        "fingerprint",
      )
      .run();

    const triggerName = `reject_grant_${suffix.replaceAll("-", "")}`;
    await env.DB.prepare(
      `CREATE TRIGGER "${triggerName}" BEFORE INSERT ON credit_ledger
       BEGIN SELECT RAISE(ABORT, 'temporary credit write failure'); END`,
    ).run();

    try {
      await expect(
        grantCredits({
          env,
          organizationId,
          credits: 5,
          idempotencyKey: `redemption-code:${codeId}`,
          description: "Redemption code grant",
          transaction: {
            before: [
              env.DB.prepare(
                `UPDATE redemption_code
                 SET redeemed_at = unixepoch(), redeemed_organization_id = ?
                 WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL`,
              ).bind(organizationId, codeId),
            ],
          },
        }),
      ).rejects.toThrow("temporary credit write failure");
    } finally {
      await env.DB.prepare(`DROP TRIGGER "${triggerName}"`).run();
    }

    expect(
      await env.DB.prepare(
        `SELECT redeemed_at AS redeemedAt, redeemed_organization_id AS organizationId
         FROM redemption_code WHERE id = ?`,
      )
        .bind(codeId)
        .first(),
    ).toEqual({ redeemedAt: null, organizationId: null });
    expect(
      await env.DB.prepare(`SELECT count(*) AS count FROM credit_ledger WHERE organization_id = ?`)
        .bind(organizationId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(`SELECT balance FROM credit_account WHERE organization_id = ?`)
        .bind(organizationId)
        .first<{ balance: number }>(),
    ).toEqual({ balance: 0 });
  });
});
