import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getRedemptionCode,
  getRedemptionCodeIssuanceStatus,
  issueRedemptionCodes,
  redeemRedemptionCode,
  revokeRedemptionCode,
  validateRedemptionCode,
} from "../src/server/modules/redemption-codes/service";

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

async function seedWorkspace() {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const organizationId = `org-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, 'Redeemer', ?, 1, unixepoch(), unixepoch())`,
    ).bind(userId, `${suffix}@example.com`),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, createdAt)
       VALUES (?, 'Redemption workspace', ?, unixepoch())`,
    ).bind(organizationId, `redemption-${suffix}`),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, 'owner', unixepoch())`,
    ).bind(`member-${suffix}`, organizationId, userId),
  ]);
  return { userId, organizationId };
}

describe("redemption code service", () => {
  it("issues defaults, normalizes input, and replays idempotently", async () => {
    const first = await issueRedemptionCodes({ env, count: 2, idempotencyKey: "issue-test" });
    const replay = await issueRedemptionCodes({ env, count: 2, idempotencyKey: "issue-test" });
    expect(first.codes).toHaveLength(2);
    expect(
      first.codes.every((row) => /^RC[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/.test(row.code)),
    ).toBe(true);
    expect(replay.codes.map((row) => row.id)).toEqual(first.codes.map((row) => row.id));
    await expect(
      issueRedemptionCodes({ env, count: 3, idempotencyKey: "issue-test" }),
    ).rejects.toThrow("different parameters");
    await expect(
      validateRedemptionCode(
        env,
        ` ${first.codes[0]!.code.toLowerCase().slice(0, 2)}-${first.codes[0]!.code.slice(2)} `,
      ),
    ).resolves.toMatchObject({
      valid: true,
      credits: 5,
    });
  });

  it("rejects unsafe issuance values and expires at the requested boundary", async () => {
    await expect(issueRedemptionCodes({ env, credits: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(issueRedemptionCodes({ env, credits: 1.5 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(issueRedemptionCodes({ env, validDays: 366 })).rejects.toMatchObject({
      status: 400,
    });
    const issuanceNow = new Date(Date.now() - 2 * 86_400_000);
    const [issued] = (await issueRedemptionCodes({ env, validDays: 1, now: issuanceNow })).codes;
    if (!issued) throw new Error("code was not issued");
    await expect(validateRedemptionCode(env, issued.code)).resolves.toMatchObject({
      valid: false,
      reason: "expired",
    });
  });

  it("enforces the UTC daily cap without a partial batch", async () => {
    const cappedEnv = new Proxy(env, {
      get(target, property) {
        return property === "REDEMPTION_CODE_DAILY_CREDITS_CAP"
          ? "10"
          : Reflect.get(target, property);
      },
    });
    const cappedNow = new Date("2099-01-01T12:00:00.000Z");
    await issueRedemptionCodes({
      env: cappedEnv,
      credits: 5,
      count: 2,
      idempotencyKey: "cap-ok",
      now: cappedNow,
    });
    await expect(
      issueRedemptionCodes({
        env: cappedEnv,
        credits: 5,
        count: 1,
        idempotencyKey: "cap-fail",
        now: cappedNow,
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect((await getRedemptionCodeIssuanceStatus(cappedEnv, cappedNow)).creditsIssued).toBe(10);
  });

  it("redeems once through the grant ledger and rolls back losing claims", async () => {
    const workspace = await seedWorkspace();
    const [issued] = (await issueRedemptionCodes({ env, credits: 7 })).codes;
    if (!issued) throw new Error("code was not issued");
    const concurrent = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        redeemRedemptionCode({
          env,
          code: issued.code,
          userId: workspace.userId,
          organizationId: workspace.organizationId,
        }),
      ),
    );
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    const ledger = await env.DB.prepare(
      `SELECT count(*) AS count FROM credit_ledger
       WHERE organization_id = ? AND idempotency_key = ? AND type = 'grant'`,
    )
      .bind(workspace.organizationId, `redemption-code:${issued.id}`)
      .first<{ count: number }>();
    expect(ledger?.count).toBe(1);
    expect(await getRedemptionCode(env, issued.code)).toMatchObject({ status: "used" });
  });

  it("keeps preview read-only and makes revoke idempotent", async () => {
    const workspace = await seedWorkspace();
    const [issued] = (await issueRedemptionCodes({ env })).codes;
    if (!issued) throw new Error("code was not issued");
    await expect(validateRedemptionCode(env, issued.code)).resolves.toMatchObject({ valid: true });
    const revoked = await revokeRedemptionCode(env, issued.code);
    expect(revoked.status).toBe("revoked");
    await expect(revokeRedemptionCode(env, issued.code)).resolves.toMatchObject({
      status: "revoked",
    });
    await expect(validateRedemptionCode(env, issued.code)).resolves.toMatchObject({
      valid: false,
      reason: "revoked",
    });
    const ledger = await env.DB.prepare(
      `SELECT count(*) AS count FROM credit_ledger WHERE organization_id = ?`,
    )
      .bind(workspace.organizationId)
      .first<{ count: number }>();
    expect(ledger?.count).toBe(0);
  });
});
