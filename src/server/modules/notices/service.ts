import { and, count, desc, eq, isNull, sql } from "drizzle-orm";

import type { Notice, NoticeInput } from "../../../shared/notices";
import { createDatabase } from "../../db";
import { notice, noticeReadStatus } from "../../db/schema";

const visible = and(eq(notice.isActive, true), isNull(notice.deletedAt));
const newestFirst = [desc(notice.createdAt), desc(notice.id)];
export const NOTICE_PAGE_SIZE = 20;

function serialize(row: typeof notice.$inferSelect, read = false, dismissed = false): Notice {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    priority: row.priority,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    isRead: read,
    isDismissed: dismissed,
  };
}

export async function listNotices(
  env: Env,
  options: { userId?: string; admin?: boolean; page: number },
) {
  const db = createDatabase(env);
  const filter = options.admin ? isNull(notice.deletedAt) : visible;
  const [rows, totals] = await Promise.all([
    db
      .select({ notice, status: noticeReadStatus })
      .from(notice)
      .leftJoin(
        noticeReadStatus,
        and(
          eq(noticeReadStatus.noticeId, notice.id),
          options.userId ? eq(noticeReadStatus.userId, options.userId) : sql`0`,
        ),
      )
      .where(filter)
      .orderBy(...newestFirst)
      .limit(NOTICE_PAGE_SIZE)
      .offset((options.page - 1) * NOTICE_PAGE_SIZE),
    db.select({ total: count() }).from(notice).where(filter),
  ]);
  return {
    data: rows.map((row) =>
      serialize(row.notice, Boolean(row.status), row.status?.dismissed ?? false),
    ),
    total: totals[0]?.total ?? 0,
    page: options.page,
    pageSize: NOTICE_PAGE_SIZE,
  };
}

export async function getNoticeSummary(env: Env, userId: string) {
  const db = createDatabase(env);
  const unread = and(
    visible,
    sql`NOT EXISTS (
    SELECT 1 FROM ${noticeReadStatus} WHERE ${noticeReadStatus.noticeId} = ${notice.id}
      AND ${noticeReadStatus.userId} = ${userId}
  )`,
  );
  const [totals, important] = await Promise.all([
    db.select({ total: count() }).from(notice).where(unread),
    db
      .select()
      .from(notice)
      .where(and(unread, eq(notice.priority, "important")))
      .orderBy(...newestFirst)
      .limit(1),
  ]);
  return {
    unreadCount: totals[0]?.total ?? 0,
    important: important[0] ? serialize(important[0]) : null,
  };
}

export async function createNotice(env: Env, userId: string, input: NoticeInput) {
  const [row] = await createDatabase(env)
    .insert(notice)
    .values({ ...input, id: crypto.randomUUID(), createdBy: userId })
    .returning();
  return serialize(row!);
}

export async function updateNotice(env: Env, id: string, input: NoticeInput) {
  const [row] = await createDatabase(env)
    .update(notice)
    .set(input)
    .where(and(eq(notice.id, id), isNull(notice.deletedAt)))
    .returning();
  return row ? serialize(row) : null;
}

export async function setNoticePublication(env: Env, id: string, isActive: boolean) {
  const [row] = await createDatabase(env)
    .update(notice)
    .set({ isActive })
    .where(and(eq(notice.id, id), isNull(notice.deletedAt)))
    .returning();
  return row ? serialize(row) : null;
}

export async function deleteNotice(env: Env, id: string) {
  const [row] = await createDatabase(env)
    .update(notice)
    .set({ isActive: false, deletedAt: new Date() })
    .where(and(eq(notice.id, id), isNull(notice.deletedAt)))
    .returning({ id: notice.id });
  return row ?? null;
}

export async function recordNoticeRead(
  env: Env,
  userId: string,
  noticeId: string,
  dismiss: boolean,
) {
  // The visibility check and upsert share one statement. Reading again must never undo dismissal.
  const result = await env.DB.prepare(`
    INSERT INTO notice_read_status (notice_id, user_id, read_at, dismissed)
    SELECT id, ?, unixepoch(), ? FROM notice
    WHERE id = ? AND is_active = 1 AND deleted_at IS NULL
    ON CONFLICT (user_id, notice_id) DO UPDATE SET
      dismissed = MAX(notice_read_status.dismissed, excluded.dismissed)
    RETURNING notice_id
  `)
    .bind(userId, dismiss ? 1 : 0, noticeId)
    .first<{ notice_id: string }>();
  return Boolean(result);
}
