export type NoticeText = { en: string; zh: string };

export type NoticeInput = {
  title: NoticeText;
  content: NoticeText;
  priority: "normal" | "important";
  isActive: boolean;
};

export type Notice = NoticeInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  isDismissed: boolean;
};

export type NoticeList = { data: Notice[]; total: number; page: number; pageSize: number };
export type NoticeSummary = { unreadCount: number; important: Notice | null };

export function localizeNotice(text: NoticeText, language: string) {
  return (language.startsWith("zh") ? text.zh : text.en) || text.en || text.zh;
}

export function emptyNotice(): NoticeInput {
  return {
    title: { en: "", zh: "" },
    content: { en: "", zh: "" },
    priority: "normal",
    isActive: false,
  };
}
