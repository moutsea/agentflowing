# Site-wide announcements

English | [简体中文](#简体中文)

## Setup

1. Apply migrations (`pnpm db:migrate:local` locally, `pnpm db:migrate:remote`
   for your configured deployment). Migration `0005_left_maestro.sql` adds
   `notice` and `notice_read_status`; it does not change existing rows.
2. Sign in to your own account and read `data.user.id` from `/api/session`.
3. Add that immutable ID to `PLATFORM_ADMIN_USER_IDS` in `.dev.vars`. Separate
   multiple IDs with commas. For production, configure this server-only value
   with `pnpm exec wrangler secret put PLATFORM_ADMIN_USER_IDS`.
4. Restart local development after changing bindings, refresh the app, and open
   **Manage announcements** (`/app/admin/notices`).

An empty allowlist grants nobody administrative access. Email addresses and
workspace owner/admin roles are not accepted as platform permissions. The
server checks the allowlist for every administrative request. Removing a user
ID revokes this capability even for existing sessions after the updated
configuration is active. No notices or administrators are seeded by default.

## Publishing and reading

- Create a draft, enter a title and body in English, Chinese, or both, then
  preview it before publishing. Titles are limited to 160 characters and
  bodies to 8,000 characters per language. Each language requires both fields.
- Content is plain text with preserved line breaks. HTML is rendered as text.
  Missing translations fall back to the other available language.
- Published notices appear for every workspace and guest. A **Normal** notice
  appears in the announcement center; an **Important** notice also appears in
  the workspace banner while unread and undismissed. The banner shows the
  latest unread important notice. The sidebar counts all unread active notices.
- Users can expand the banner, mark it read, or dismiss it. Dismissal also marks
  it read. The notice remains available in the center. Preferences are stored
  per user and follow them across devices and workspaces. Guests can read but
  cannot save read/dismiss preferences.
- Workspace banners refresh on window focus and every 60 seconds while the
  document is visible. The signed-in announcement center loads current content when
  opened and refreshes in the background without interrupting reading. Administrator saves refresh that administrator's banner immediately.
- Taking a notice offline hides it from all user-facing reads and counts.
  Publishing it again retains existing read/dismiss preferences. Edits also
  retain preferences; create a new notice when everyone should be alerted again.
- Delete soft-deletes a notice and removes it from both management and public
  views. There is no restore action in the UI or API; use **Take offline** for
  temporary removal.

## Routes and API

| Route                           | Purpose                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `/notices`                      | Public announcement center, linked from the home page                 |
| `/app/notices`                  | Signed-in announcement center                                         |
| `/app/admin/notices`            | Platform administrator management                                     |
| `GET /api/notices?page=1`       | Active notices; optional session adds personal read/dismiss flags     |
| `GET /api/notices/summary`      | Signed-in user's unread count and latest unread important notice      |
| `POST /api/notices/:id/read`    | Mark an active notice read for the current user                       |
| `POST /api/notices/:id/dismiss` | Dismiss and mark an active notice read for the current user           |
| `GET /api/admin/notices?page=1` | All non-deleted notices, including drafts (platform admin)            |
| `POST /api/admin/notices`       | Create a notice (platform admin)                                      |
| `PUT /api/admin/notices/:id`    | Replace editable fields (platform admin)                              |
| `PATCH /api/admin/notices/:id`  | Change publication only, with `{ "isActive": true }` (platform admin) |
| `DELETE /api/admin/notices/:id` | Soft-delete (platform admin)                                          |

Publish/offline buttons use `PATCH` so a stale list cannot overwrite newer title
or body edits. Authenticated writes share the per-user `API_RATE_LIMITER`; a
limited request returns `429` with `Retry-After: 60`.

Create/update payload (all four top-level fields required):

```json
{
  "title": { "en": "Scheduled maintenance", "zh": "系统维护" },
  "content": { "en": "A short update from the team.", "zh": "来自团队的最新消息。" },
  "priority": "important",
  "isActive": true
}
```

Lists return `{ data, total, page, pageSize }`, with 20 notices per page, ordered
by creation date descending and ID as the tie breaker. `page` must be an integer
between 1 and 100000. Notice DTOs expose `id`, the editable fields, ISO timestamps,
`isRead`, and `isDismissed`, never the author's user ID. Summary returns
`{ data: { unreadCount, important } }`; `important` is a notice or `null`.

Authentication uses the normal Better Auth session cookie, not workspace API
keys. Unauthorized requests return `401`; authenticated non-administrators
receive `403`. Hidden/deleted/missing notices return `404` for read/dismiss
actions. Mutations reject a foreign `Origin`. Responses use `private, no-store`
so one user's status cannot be cached for another.

## 简体中文

1. 先运行数据库迁移：本地 `pnpm db:migrate:local`；部署环境使用
   `pnpm db:migrate:remote`。新增迁移只创建通告和用户阅读状态表。
2. 登录自己的账号，从 `/api/session` 返回的 `data.user.id` 获取用户 ID。
3. 本地在 `.dev.vars` 设置 `PLATFORM_ADMIN_USER_IDS`，多个 ID 用逗号分隔。
   生产环境执行 `pnpm exec wrangler secret put PLATFORM_ADMIN_USER_IDS` 配置。
4. 重启本地服务并刷新页面，在侧边栏打开「通告管理」或直接访问
   `/app/admin/notices`。

平台管理员可创建草稿、编辑、发布、下线和删除通告，支持中英文标题与正文。
至少完整填写一种语言，另一种缺失时自动回退。标题每种语言最多 160 字符，
正文最多 8,000 字符；正文为纯文本，保留换行，不执行 HTML。

通告面向所有用户，与工作空间无关。用户在 `/app/notices` 查看，访客也可通过
首页「通告」进入 `/notices` 查看已发布内容。重要通告显示在工作台顶部，侧边栏
显示未读数；提醒在窗口获得焦点时以及页面可见时每 60 秒刷新。

已读和关闭状态按用户持久化保存，跨工作空间和设备一致。关闭同时标为已读，
仍可在通告中心回看。下线后所有用户都不可见；编辑或重新发布保留已有阅读状态。
需要重新提醒所有人时，请新建通告。删除会从管理页和用户页移除，界面不提供恢复；
临时隐藏请用「下线」。

管理员名单默认为空，工作空间的 owner/admin 无权发布全站通告。后端每次请求
都会校验平台管理员用户 ID，前端只接收当前用户是否具备该权限，不接收名单。
