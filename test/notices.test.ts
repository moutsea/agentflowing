import { applyD1Migrations, createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "../src/server";
import { isPlatformAdmin } from "../src/server/middleware/platform-admin";
import type { Notice, NoticeList, NoticeSummary } from "../src/shared/notices";

const files = import.meta.glob("../migrations/*.sql", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;
const migrations = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, sql]) => ({
    name: path.split("/").at(-1)!,
    queries: sql
      .split("--> statement-breakpoint")
      .map((query) => query.trim())
      .filter(Boolean),
  }));
const input = {
  title: { en: "Scheduled maintenance", zh: "系统维护" },
  content: { en: "An update is coming.\nYour work is saved.", zh: "即将更新，您的工作已保存。" },
  priority: "important",
  isActive: true,
};

function request(
  path: string,
  options: {
    cookie?: string;
    adminId?: string;
    method?: string;
    body?: unknown;
    origin?: string;
  } = {},
) {
  const runtime = { ...env, PLATFORM_ADMIN_USER_IDS: options.adminId ?? "" };
  return app.fetch(
    new Request(`${env.APP_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "content-type": "application/json",
        origin: options.origin ?? env.APP_URL,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    runtime,
    createExecutionContext(),
  );
}

async function signUp() {
  const response = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: {
      name: "Notice reader",
      email: `notice-${crypto.randomUUID()}@example.com`,
      password: "a-local-test-password-1234",
    },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { user: { id: string } };
  return {
    id: body.user.id,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; "),
  };
}

async function publish(admin: { id: string; cookie: string }, overrides = {}) {
  const response = await request("/api/admin/notices", {
    cookie: admin.cookie,
    adminId: admin.id,
    method: "POST",
    body: { ...input, ...overrides },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { data: Notice }).data;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notice_read_status"),
    env.DB.prepare("DELETE FROM notice"),
  ]);
});

describe("site-wide announcements", () => {
  it("requires an exact configured platform user ID, never a workspace owner or client-supplied role", async () => {
    expect(isPlatformAdmin({}, "someone")).toBe(false);
    expect(isPlatformAdmin({ PLATFORM_ADMIN_USER_IDS: " admin-a, admin-b, " }, "admin-b")).toBe(
      true,
    );
    expect(isPlatformAdmin({ PLATFORM_ADMIN_USER_IDS: "admin-ab" }, "admin-a")).toBe(false);
    const owner = await signUp();
    const session = await request("/api/session", { cookie: owner.cookie });
    expect(await session.json()).toMatchObject({ data: { role: "owner", isPlatformAdmin: false } });
    for (const [method, path] of [
      ["GET", ""],
      ["POST", ""],
      ["PUT", "/anything"],
      ["PATCH", "/anything"],
      ["DELETE", "/anything"],
    ]) {
      const body =
        method === "POST" || method === "PUT" ? { ...input, isPlatformAdmin: true } : undefined;
      expect((await request(`/api/admin/notices${path}`, { method, body })).status).toBe(401);
      expect(
        (await request(`/api/admin/notices${path}`, { cookie: owner.cookie, method, body })).status,
      ).toBe(403);
    }
    const adminSession = await request("/api/session", { cookie: owner.cookie, adminId: owner.id });
    expect(await adminSession.json()).toMatchObject({ data: { isPlatformAdmin: true } });
  });

  it("publishes globally while keeping drafts and author IDs out of public responses", async () => {
    const admin = await signUp();
    const reader = await signUp();
    const published = await publish(admin);
    await publish(admin, { isActive: false });
    for (const cookie of [undefined, reader.cookie, admin.cookie]) {
      const response = await request("/api/notices", { cookie });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = (await response.json()) as NoticeList;
      expect(body.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({ id: published.id, title: input.title, isRead: false });
      expect(body.data[0]).not.toHaveProperty("createdBy");
    }
    const all = await request("/api/admin/notices", { cookie: admin.cookie, adminId: admin.id });
    expect(await all.json()).toMatchObject({ total: 2 });
  });

  it("persists dismissal only for its user, survives read retries, and keeps the notice in the center", async () => {
    const admin = await signUp();
    const reader = await signUp();
    const notice = await publish(admin);
    await publish(admin, { priority: "normal" });
    const before = await request("/api/notices/summary", { cookie: reader.cookie });
    expect(await before.json()).toMatchObject({
      data: { unreadCount: 2, important: { id: notice.id } },
    });
    const responses = await Promise.all(
      ["dismiss", "read", "dismiss"].map((action) =>
        request(`/api/notices/${notice.id}/${action}`, { cookie: reader.cookie, method: "POST" }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const summary = await request("/api/notices/summary", { cookie: reader.cookie });
    expect(await summary.json()).toMatchObject({ data: { unreadCount: 1, important: null } });
    const list = await request("/api/notices", { cookie: reader.cookie });
    expect(
      ((await list.json()) as NoticeList).data.find((row) => row.id === notice.id),
    ).toMatchObject({ isRead: true, isDismissed: true });
    const other = await request("/api/notices/summary", { cookie: admin.cookie });
    expect(await other.json()).toMatchObject({
      data: { unreadCount: 2, important: { id: notice.id } },
    });
    const count = await env.DB.prepare(
      "SELECT count(*) AS total FROM notice_read_status WHERE notice_id = ? AND user_id = ?",
    )
      .bind(notice.id, reader.id)
      .first<{ total: number }>();
    expect(count?.total).toBe(1);
  });

  it("takes notices offline, republishes them, and soft-deletes without resurrection", async () => {
    const admin = await signUp();
    const notice = await publish(admin);
    const auth = { cookie: admin.cookie, adminId: admin.id };
    const edit = await request(`/api/admin/notices/${notice.id}`, {
      ...auth,
      method: "PUT",
      body: {
        ...input,
        title: { en: "Edited", zh: "" },
        content: { en: "Updated", zh: "" },
        isActive: false,
      },
    });
    expect(edit.status).toBe(200);
    expect(await (await request("/api/notices")).json()).toMatchObject({ total: 0 });
    expect(
      (await request(`/api/notices/${notice.id}/read`, { cookie: admin.cookie, method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await request(`/api/admin/notices/${notice.id}`, { ...auth, method: "PUT", body: input }))
        .status,
    ).toBe(200);
    expect(await (await request("/api/notices")).json()).toMatchObject({ total: 1 });
    expect(
      (await request(`/api/admin/notices/${notice.id}`, { ...auth, method: "DELETE" })).status,
    ).toBe(200);
    expect(await (await request("/api/admin/notices", auth)).json()).toMatchObject({ total: 0 });
    expect(
      (await request(`/api/admin/notices/${notice.id}`, { ...auth, method: "PUT", body: input }))
        .status,
    ).toBe(404);
    expect(
      (await request(`/api/notices/${notice.id}/dismiss`, { cookie: admin.cookie, method: "POST" }))
        .status,
    ).toBe(404);
    const summary = (await (
      await request("/api/notices/summary", { cookie: admin.cookie })
    ).json()) as { data: NoticeSummary };
    expect(summary.data).toEqual({ unreadCount: 0, important: null });
  });

  it("changes publication without overwriting content edited since the list was loaded", async () => {
    const admin = await signUp();
    const original = await publish(admin);
    const auth = { cookie: admin.cookie, adminId: admin.id };
    const current = {
      ...input,
      title: { en: "New revision", zh: "新版本" },
      content: { en: "Latest body", zh: "最新正文" },
    };
    expect(
      (
        await request(`/api/admin/notices/${original.id}`, {
          ...auth,
          method: "PUT",
          body: current,
        })
      ).status,
    ).toBe(200);
    for (const isActive of [false, true]) {
      const response = await request(`/api/admin/notices/${original.id}`, {
        ...auth,
        method: "PATCH",
        body: { isActive },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { ...current, isActive } });
    }
    for (const body of [{}, { isActive: "true" }, { isActive: true, title: original.title }]) {
      expect(
        (await request(`/api/admin/notices/${original.id}`, { ...auth, method: "PATCH", body }))
          .status,
      ).toBe(400);
    }
    await request(`/api/admin/notices/${original.id}`, { ...auth, method: "DELETE" });
    expect(
      (
        await request(`/api/admin/notices/${original.id}`, {
          ...auth,
          method: "PATCH",
          body: { isActive: true },
        })
      ).status,
    ).toBe(404);
  });

  it("limits all notice writes by user and leaves reads available", async () => {
    const admin = await signUp();
    const notice = await publish(admin);
    const limit = vi.spyOn(env.API_RATE_LIMITER, "limit").mockResolvedValue({ success: false });
    try {
      for (const [method, path, body] of [
        ["POST", `/api/notices/${notice.id}/read`, undefined],
        ["POST", `/api/notices/${notice.id}/dismiss`, undefined],
        ["POST", "/api/admin/notices", input],
        ["PUT", `/api/admin/notices/${notice.id}`, input],
        ["PATCH", `/api/admin/notices/${notice.id}`, { isActive: false }],
        ["DELETE", `/api/admin/notices/${notice.id}`, undefined],
      ] as const) {
        const response = await request(path, {
          method,
          body,
          cookie: admin.cookie,
          adminId: admin.id,
        });
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("60");
      }
      expect(limit).toHaveBeenCalledTimes(6);
      expect(limit).toHaveBeenLastCalledWith({ key: `notices:${admin.id}` });
      const response = await request("/api/notices", { cookie: admin.cookie });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        total: 1,
        data: [{ id: notice.id, isActive: true, isRead: false }],
      });
    } finally {
      limit.mockRestore();
    }
  });

  it("validates language pairs, whitespace, limits, priority and unexpected fields", async () => {
    const admin = await signUp();
    for (const invalid of [
      { title: { en: " ", zh: "" } },
      { content: { en: "", zh: "" } },
      { title: { en: "only English", zh: "" }, content: { en: "", zh: "只有中文" } },
      { title: { en: "x".repeat(161), zh: "" } },
      { content: { en: "x".repeat(8001), zh: "" } },
      { priority: "urgent" },
      { isActive: "true" },
      { createdBy: "forged-user" },
    ]) {
      expect(
        (
          await request("/api/admin/notices", {
            cookie: admin.cookie,
            adminId: admin.id,
            method: "POST",
            body: { ...input, ...invalid },
          })
        ).status,
      ).toBe(400);
    }
    const chinese = await publish(admin, {
      title: { zh: "  中文通告 " },
      content: { zh: " 正文 " },
    });
    expect(chinese.title).toEqual({ en: "", zh: "中文通告" });
    expect(chinese.content).toEqual({ en: "", zh: "正文" });
  });

  it("rejects malformed JSON and oversized bodies with client errors", async () => {
    const admin = await signUp();
    for (const [body, status] of [
      ["{", 400],
      [JSON.stringify({ ...input, content: { en: "x".repeat(140000) } }), 413],
    ] as const) {
      const response = await app.fetch(
        new Request(`${env.APP_URL}/api/admin/notices`, {
          method: "POST",
          headers: {
            cookie: admin.cookie,
            "content-type": "application/json",
            origin: env.APP_URL,
          },
          body,
        }),
        { ...env, PLATFORM_ADMIN_USER_IDS: admin.id },
        createExecutionContext(),
      );
      expect(response.status).toBe(status);
    }
  });

  it("requires authentication for read state and rejects cross-origin mutations", async () => {
    const admin = await signUp();
    const notice = await publish(admin);
    expect((await request("/api/notices/summary")).status).toBe(401);
    expect((await request(`/api/notices/${notice.id}/read`, { method: "POST" })).status).toBe(401);
    expect(
      (
        await request(`/api/notices/${notice.id}/read`, {
          cookie: admin.cookie,
          method: "POST",
          origin: "https://other.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/admin/notices", {
          cookie: admin.cookie,
          adminId: admin.id,
          method: "POST",
          body: input,
          origin: "https://other.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/notices/missing/read", { cookie: admin.cookie, method: "POST" })).status,
    ).toBe(404);
  });

  it("bounds and paginates public/admin lists with deterministic ordering", async () => {
    const admin = await signUp();
    await env.DB.batch(
      Array.from({ length: 23 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO notice (id, title, content, priority, is_active) VALUES (?, ?, ?, 'normal', 1)",
        ).bind(
          `page-${String(index).padStart(2, "0")}`,
          JSON.stringify(input.title),
          JSON.stringify(input.content),
        ),
      ),
    );
    for (const path of ["/api/notices", "/api/admin/notices"]) {
      const auth = { cookie: admin.cookie, adminId: admin.id };
      const first = (await (await request(path, auth)).json()) as NoticeList;
      const second = (await (await request(`${path}?page=2`, auth)).json()) as NoticeList;
      expect(first.total).toBe(23);
      expect(first.data).toHaveLength(20);
      expect(second.data).toHaveLength(3);
      expect(new Set([...first.data, ...second.data].map((row) => row.id)).size).toBe(23);
      for (const page of ["0", "-1", "2.5", "invalid", "100001"])
        expect((await request(`${path}?page=${page}`, auth)).status).toBe(400);
    }
  });
});

describe("chat transport alongside announcements", () => {
  it("preserves HTTP and WebSocket responses through the security middleware", async () => {
    const reader = await signUp();
    const agents = (await (await request("/api/agents", { cookie: reader.cookie })).json()) as {
      data: { id: string }[];
    };
    const created = await request("/api/chats", {
      cookie: reader.cookie,
      method: "POST",
      body: { agentId: agents.data[0]!.id },
    });
    const chat = (await created.json()) as { data: { id: string } };
    const path = `/agents/monetized-agent/${chat.data.id}`;
    const messages = await request(`${path}/get-messages`, { cookie: reader.cookie });
    expect(messages.status).toBe(200);
    expect(await messages.json()).toEqual([]);
    expect(messages.headers.get("x-content-type-options")).toBe("nosniff");
    expect(messages.headers.get("x-request-id")).toBeTruthy();
    const upgrade = await app.fetch(
      new Request(`${env.APP_URL}${path}`, {
        headers: { cookie: reader.cookie, Upgrade: "websocket" },
      }),
      env,
      createExecutionContext(),
    );
    expect(upgrade.status).toBe(101);
    expect(upgrade.webSocket).not.toBeNull();
    upgrade.webSocket!.accept();
    upgrade.webSocket!.close();
  });
});
