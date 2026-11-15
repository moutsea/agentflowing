import { applyD1Migrations, createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";

import { app } from "../src/server";
import { issueCoupon } from "../src/server/modules/coupons/service";
import { issueRedemptionCodes } from "../src/server/modules/redemption-codes/service";

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

it.each([
  ["coupons", "validate", "coupon"],
  ["redemption-codes", "validate", "redemption_code"],
  ["redemption-codes", "redeem", "redemption_code"],
])("keeps %s/%s database failures private and retryable", async (resource, action, table) => {
  const signup = await SELF.fetch(`${env.APP_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.APP_URL },
    body: JSON.stringify({
      name: "Private code reader",
      email: `${crypto.randomUUID()}@example.com`,
      password: "correct-horse-battery-staple",
    }),
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const issued =
    resource === "coupons"
      ? await issueCoupon({ env, rate: 20 })
      : (await issueRedemptionCodes({ env })).codes[0]!;
  const database = new Proxy(env.DB, {
    get(db, property) {
      if (property === "prepare")
        return (sql: string) => {
          const statement = db.prepare(sql);
          if (!sql.includes(`from "${table}"`)) return statement;
          const failRead = (stmt: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(stmt, {
              get(target, key) {
                if (key === "bind")
                  return (...values: unknown[]) => failRead(target.bind(...values));
                if (["raw", "all", "first"].includes(String(key)))
                  return async () => {
                    throw new Error("temporary database failure");
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          return failRead(statement);
        };
      const value = Reflect.get(db, property);
      return typeof value === "function" ? value.bind(db) : value;
    },
  });
  const requestEnv = new Proxy(env, {
    get(target, key) {
      return key === "DB" ? database : Reflect.get(target, key);
    },
  });
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await app.fetch(
      new Request(`${env.APP_URL}/api/billing/${resource}/${action}`, {
        method: "POST",
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/json",
          "x-request-id": "private-code-failure",
        },
        body: JSON.stringify({ code: issued.code }),
      }),
      requestEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(500);
    const records = JSON.stringify([...logs.mock.calls, ...errors.mock.calls]);
    expect(records).not.toContain(issued.code);
    expect(records).not.toContain("params:");
    const failure = errors.mock.calls
      .map(([record]) => JSON.parse(String(record)))
      .find((record) => record.event === "request.failed");
    expect(failure).toMatchObject({
      requestId: "private-code-failure",
      error: "database_error",
      retryable: true,
      objectId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await response.json()).toMatchObject({
      error: "internal_error",
      messages: { en: expect.any(String), "zh-CN": expect.any(String) },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe("private-code-failure");
    expect(
      await env.DB.prepare(`SELECT redeemed_at AS redeemedAt FROM ${table} WHERE id = ?`)
        .bind(issued.id)
        .first(),
    ).toMatchObject({ redeemedAt: null });
  } finally {
    logs.mockRestore();
    errors.mockRestore();
  }
});

it("does not log SQL-bound credentials when an unrelated global request fails", async () => {
  const code = (await issueCoupon({ env, rate: 20 })).code;
  const requestEnv = new Proxy(env, {
    get(target, property) {
      if (property === "DIRECT_QR_CURRENCY") throw new Error(`Failed query params: ${code}`);
      return Reflect.get(target, property);
    },
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await app.fetch(
      new Request(`${env.APP_URL}/api/billing/catalog`, {
        headers: { "x-request-id": "global-private-failure" },
      }),
      requestEnv,
      createExecutionContext(),
    );
    expect(JSON.stringify(errors.mock.calls)).not.toContain(code);
    expect(response.status).toBe(500);
  } finally {
    errors.mockRestore();
  }
});
