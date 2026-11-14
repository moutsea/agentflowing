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

async function seedRedemptionCode(
  suffix: string,
  options: { createdAt?: number; expiresAt?: number; revokedAt?: number | null } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const codeId = `code-${suffix}`;
  await env.DB.prepare(
    `INSERT INTO redemption_code
     (id, code, credits, expires_at, redeemed_organization_id, redeemed_at, revoked_at,
      idempotency_key, request_fingerprint, batch_index, createdAt, updatedAt)
     VALUES (?, ?, 5, ?, NULL, NULL, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      codeId,
      `RC${suffix.replaceAll("-", "").slice(0, 12)}`,
      options.expiresAt ?? now + 3600,
      options.revokedAt ?? null,
      `issue:${suffix}`,
      "fingerprint",
      options.createdAt ?? now,
      now,
    )
    .run();
  return codeId;
}

function claimRedemptionCode(organizationId: string, codeId: string) {
  return env.DB.prepare(
    `UPDATE redemption_code
     SET redeemed_at = unixepoch(), redeemed_organization_id = ?
     WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > unixepoch()`,
  ).bind(organizationId, codeId);
}

async function getGrantState(organizationId: string, codeId: string) {
  const [code, ledger, account] = await Promise.all([
    env.DB.prepare(
      `SELECT redeemed_at AS redeemedAt, redeemed_organization_id AS redeemedOrganizationId,
              revoked_at AS revokedAt
       FROM redemption_code WHERE id = ?`,
    )
      .bind(codeId)
      .first(),
    env.DB.prepare(
      `SELECT count(*) AS count FROM credit_ledger
       WHERE organization_id = ? AND idempotency_key = ?`,
    )
      .bind(organizationId, `redemption-code:${codeId}`)
      .first<{ count: number }>(),
    env.DB.prepare(`SELECT balance FROM credit_account WHERE organization_id = ?`)
      .bind(organizationId)
      .first<{ balance: number }>(),
  ]);
  return { code, ledger, account };
}

describe("grantCredits", () => {
  it("replays one organization/key as one ledger entry and returns committed balance", async () => {
    const { organizationId } = await seedOrganization();
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        grantCredits({
          env,
          organizationId,
          credits: 7,
          idempotencyKey: "test:grant:replay",
          description: `Test grant ${index}`,
          referenceType: "test",
          referenceId: organizationId,
        }),
      ),
    );
    const first = concurrent.find((result) => !result.duplicate)!;
    expect(concurrent.filter((result) => !result.duplicate)).toHaveLength(1);
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

  it.each([
    ["revoked", { revokedAt: Math.floor(Date.now() / 1000) }],
    [
      "expired",
      {
        createdAt: Math.floor(Date.now() / 1000) - 7200,
        expiresAt: Math.floor(Date.now() / 1000) - 3600,
      },
    ],
  ] as const)(
    "aborts a %s zero-row claim without changing ledger or balance",
    async (_, options) => {
      const { organizationId, suffix } = await seedOrganization();
      const codeId = await seedRedemptionCode(suffix, options);

      await expect(
        grantCredits({
          env,
          organizationId,
          credits: 5,
          idempotencyKey: `redemption-code:${codeId}`,
          description: "Redemption code grant",
          transaction: { before: [claimRedemptionCode(organizationId, codeId)] },
        }),
      ).rejects.toThrow();

      await expect(getGrantState(organizationId, codeId)).resolves.toMatchObject({
        ledger: { count: 0 },
        account: { balance: 0 },
        code: { redeemedAt: null, redeemedOrganizationId: null },
      });
    },
  );

  it("allows an already redeemed code to replay its existing idempotent grant", async () => {
    const { organizationId, suffix } = await seedOrganization();
    const codeId = await seedRedemptionCode(suffix);
    const params = {
      env,
      organizationId,
      credits: 5,
      idempotencyKey: `redemption-code:${codeId}`,
      description: "Redemption code grant",
    } as const;

    const first = await grantCredits({
      ...params,
      transaction: { before: [claimRedemptionCode(organizationId, codeId)] },
    });
    const replay = await grantCredits({
      ...params,
      transaction: { before: [claimRedemptionCode(organizationId, codeId)] },
    });

    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    await expect(getGrantState(organizationId, codeId)).resolves.toMatchObject({
      ledger: { count: 1 },
      account: { balance: 5 },
      code: { redeemedOrganizationId: organizationId },
    });
  });

  it("lets a concurrent revoke or claim win exactly once", async () => {
    const { organizationId, suffix } = await seedOrganization();
    const codeId = await seedRedemptionCode(suffix);
    const revoke = env.DB.prepare(
      `UPDATE redemption_code SET revoked_at = unixepoch()
       WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > unixepoch()`,
    ).bind(codeId);
    const claim = grantCredits({
      env,
      organizationId,
      credits: 5,
      idempotencyKey: `redemption-code:${codeId}`,
      description: "Redemption code grant",
      transaction: { before: [claimRedemptionCode(organizationId, codeId)] },
    });
    const [claimResult, revokeResult] = await Promise.allSettled([claim, revoke.run()]);
    const claimWon = claimResult.status === "fulfilled";
    const revokeWon = revokeResult.status === "fulfilled" && revokeResult.value.meta.changes === 1;

    expect(claimWon !== revokeWon).toBe(true);
    const state = await getGrantState(organizationId, codeId);
    if (claimWon) {
      expect(state).toMatchObject({ ledger: { count: 1 }, account: { balance: 5 } });
      expect(state.code).toMatchObject({ redeemedOrganizationId: organizationId, revokedAt: null });
    } else {
      expect(state).toMatchObject({ ledger: { count: 0 }, account: { balance: 0 } });
      expect(state.code).toMatchObject({ redeemedOrganizationId: null });
      expect(state.code).toHaveProperty("revokedAt");
    }
  });

  it("rolls back a claim when the before statement itself fails", async () => {
    const { organizationId, suffix } = await seedOrganization();
    const codeId = await seedRedemptionCode(suffix);
    const triggerName = `reject_claim_${suffix.replaceAll("-", "")}`;
    await env.DB.prepare(
      `CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON redemption_code
       BEGIN SELECT RAISE(ABORT, 'temporary claim failure'); END`,
    ).run();

    try {
      await expect(
        grantCredits({
          env,
          organizationId,
          credits: 5,
          idempotencyKey: `redemption-code:${codeId}`,
          description: "Redemption code grant",
          transaction: { before: [claimRedemptionCode(organizationId, codeId)] },
        }),
      ).rejects.toThrow("temporary claim failure");
    } finally {
      await env.DB.prepare(`DROP TRIGGER "${triggerName}"`).run();
    }

    await expect(getGrantState(organizationId, codeId)).resolves.toMatchObject({
      ledger: { count: 0 },
      account: { balance: 0 },
      code: { redeemedAt: null, redeemedOrganizationId: null },
    });
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
