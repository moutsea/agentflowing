import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleStop,
  Coins,
  Copy,
  FileText,
  MoreHorizontal,
  Paperclip,
  PanelRight,
  RotateCcw,
  Sparkles,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";

import { apiRequest } from "../lib/api";
import { useWorkspace } from "../workspace";

type ChatDetail = {
  id: string;
  title: string;
  status: "active" | "archived";
  updatedAt: string;
  agentId: string;
  agentName: string;
  agentDescription: string;
  model: string;
  creditCost: number;
};

type Attachment = {
  id: string;
  name: string;
  contentType: string;
  size: number;
};

const suggestions = [
  "Estimate MRR for 250 users at $29 with 4% churn",
  "Design a pricing ladder for a research agent",
  "What should I measure before launching?",
];

function MessagePart({ part, isUser }: { part: UIMessage["parts"][number]; isUser: boolean }) {
  const { t } = useTranslation();
  if (part.type === "text") {
    return <div className={isUser ? "chat-bubble user" : "chat-bubble assistant"}>{part.text}</div>;
  }
  if (isToolUIPart(part)) {
    return (
      <div className="tool-card">
        <span>
          <Wrench size={14} /> {getToolName(part)}
        </span>
        <strong>{part.state === "output-available" ? t("Completed") : t("Running")}</strong>
      </div>
    );
  }
  return null;
}

export function AgentPage() {
  const { t } = useTranslation();
  const { chatId = "" } = useParams();
  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setError("");
    void apiRequest<{ data: ChatDetail }>(`/api/chats/${encodeURIComponent(chatId)}`)
      .then(({ data }) => {
        if (active) setChat(data);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : t("Could not load chat"));
      });
    return () => {
      active = false;
    };
  }, [chatId, t]);

  if (error) {
    return (
      <div className="route-state">
        <strong>{t("Conversation unavailable")}</strong>
        <p>{error}</p>
        <Link className="button button-light" to="/app">
          {t("Back to dashboard")}
        </Link>
      </div>
    );
  }
  if (!chat) {
    return (
      <div className="route-state">
        <span className="route-loader" />
        <strong>{t("Opening durable conversation")}</strong>
        <p>{t("Restoring messages and connection state…")}</p>
      </div>
    );
  }

  return <AgentConversation chat={chat} />;
}

function AgentConversation({ chat }: { chat: ChatDetail }) {
  const { t } = useTranslation();
  const { refreshWorkspace } = useWorkspace();
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [showAttachments, setShowAttachments] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef<string>("ready");
  const agent = useAgent({
    agent: "MonetizedAgent",
    name: chat.id,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
  });
  const { messages, sendMessage, clearHistory, stop, status, error } = useAgentChat({
    agent,
    experimental_throttle: 80,
  });
  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    void apiRequest<{ data: Attachment[] }>("/api/files")
      .then(({ data }) =>
        setAttachments(
          data.filter((item) =>
            ["application/json", "text/csv", "text/markdown", "text/plain"].includes(
              item.contentType,
            ),
          ),
        ),
      )
      .catch(() => setAttachments([]));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const wasRunning =
      previousStatus.current === "streaming" || previousStatus.current === "submitted";
    if (wasRunning && !isStreaming) void refreshWorkspace();
    previousStatus.current = status;
  }, [isStreaming, refreshWorkspace, status]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    void sendMessage(
      { role: "user", parts: [{ type: "text", text }] },
      { body: { assetIds: selectedAttachmentIds } },
    );
    setSelectedAttachmentIds([]);
    setShowAttachments(false);
  };

  const copyMessage = async (message: UIMessage) => {
    const text = message.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId(""), 1500);
  };

  return (
    <div className="agent-workspace">
      <header className="agent-header">
        <div className="agent-identity">
          <span className="agent-identity-icon">
            <Sparkles size={18} />
          </span>
          <div>
            <h1>{chat.agentName}</h1>
            <span>
              <i className={connected ? "online" : ""} />
              {connected ? t("Connected") : t("Connecting")}
            </span>
          </div>
          <button type="button">
            <ChevronDown size={15} />
          </button>
        </div>
        <div className="agent-header-actions">
          <button
            className="icon-button"
            onClick={clearHistory}
            type="button"
            title={t("Clear conversation")}
          >
            <RotateCcw size={17} />
          </button>
          <button className="icon-button" type="button" title={t("Toggle inspector")}>
            <PanelRight size={17} />
          </button>
          <button className="icon-button" type="button">
            <MoreHorizontal size={18} />
          </button>
        </div>
      </header>

      <div className="agent-content">
        <section className="chat-stage">
          <div className="chat-scroll">
            <div className="chat-inner">
              {messages.length === 0 ? (
                <div className="chat-empty">
                  <span className="chat-empty-icon">
                    <Bot size={28} />
                  </span>
                  <span className="eyebrow">{chat.agentName}</span>
                  <h2>{t("Turn a question into a decision.")}</h2>
                  <p>{chat.agentDescription}</p>
                  <div className="suggestion-list">
                    {suggestions.map((suggestion) => (
                      <button key={suggestion} onClick={() => setInput(suggestion)} type="button">
                        <Sparkles size={14} /> {t(suggestion)}
                        <ArrowUp size={14} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="message-list">
                  {messages.map((message) => {
                    const isUser = message.role === "user";
                    return (
                      <div className={isUser ? "message-row user" : "message-row"} key={message.id}>
                        {!isUser && (
                          <span className="message-avatar">
                            <Sparkles size={14} />
                          </span>
                        )}
                        <div className="message-parts">
                          {message.parts.map((part, index) => (
                            <MessagePart
                              key={`${message.id}-${index}`}
                              part={part}
                              isUser={isUser}
                            />
                          ))}
                          {!isUser && (
                            <div className="message-actions">
                              <button
                                onClick={() => void copyMessage(message)}
                                type="button"
                                title={t("Copy response")}
                              >
                                {copiedMessageId === message.id ? (
                                  <Check size={13} />
                                ) : (
                                  <Copy size={13} />
                                )}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {isStreaming && (
                    <div className="streaming-label">
                      <span />
                      <span />
                      <span /> {t("Agent is working")}
                    </div>
                  )}
                  {error && <div className="chat-error">{error.message}</div>}
                </div>
              )}
              <div ref={endRef} />
            </div>
          </div>

          <form className="agent-composer-wrap" onSubmit={submit}>
            {selectedAttachmentIds.length > 0 && (
              <div className="selected-attachments">
                {selectedAttachmentIds.map((assetId) => {
                  const asset = attachments.find((item) => item.id === assetId);
                  if (!asset) return null;
                  return (
                    <span key={asset.id}>
                      <FileText size={12} /> {asset.name}
                      <button
                        aria-label={t("Remove {{name}}", { name: asset.name })}
                        onClick={() =>
                          setSelectedAttachmentIds((current) =>
                            current.filter((item) => item !== asset.id),
                          )
                        }
                        type="button"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            <div className="agent-composer">
              <textarea
                aria-label={t("Message")}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={t("Ask the agent to research, compare, or model…")}
                rows={2}
              />
              <div className="composer-footer">
                <div>
                  <button
                    className={showAttachments ? "active" : ""}
                    onClick={() => setShowAttachments((current) => !current)}
                    type="button"
                    title={t("Attach workspace files")}
                  >
                    <Paperclip size={17} />
                  </button>
                  <span
                    title={t(
                      "Each continuation is a separate model run. Interrupted recovery attempts are refunded.",
                    )}
                  >
                    <Zap size={13} /> {chat.creditCost}{" "}
                    {t(chat.creditCost === 1 ? "credit / model run" : "credits / model run")}
                  </span>
                </div>
                {isStreaming ? (
                  <button className="send-button stop" onClick={stop} type="button">
                    <CircleStop size={18} />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    disabled={!input.trim() || !connected}
                    type="submit"
                  >
                    <ArrowUp size={18} />
                  </button>
                )}
              </div>
            </div>
            {showAttachments && (
              <div className="attachment-picker">
                <div>
                  <strong>{t("Workspace context")}</strong>
                  <small>{t("Select up to 6 text, Markdown, CSV, or JSON files.")}</small>
                </div>
                <div className="attachment-options">
                  {attachments.map((asset) => {
                    const selected = selectedAttachmentIds.includes(asset.id);
                    return (
                      <button
                        className={selected ? "selected" : ""}
                        key={asset.id}
                        onClick={() =>
                          setSelectedAttachmentIds((current) => {
                            if (current.includes(asset.id)) {
                              return current.filter((item) => item !== asset.id);
                            }
                            return current.length < 6 ? [...current, asset.id] : current;
                          })
                        }
                        type="button"
                      >
                        <FileText size={14} />
                        <span>
                          <strong>{asset.name}</strong>
                          <small>{Math.max(1, Math.round(asset.size / 1024))} KB</small>
                        </span>
                        {selected && <Check size={14} />}
                      </button>
                    );
                  })}
                  {attachments.length === 0 && (
                    <p>
                      <Trans
                        components={{ settings: <Link to="/app/settings" /> }}
                        i18nKey="Upload a text file in <settings>Settings</settings> first."
                      />
                    </p>
                  )}
                </div>
              </div>
            )}
            <small>{t("AgentFlowing can make mistakes. Review important actions.")}</small>
          </form>
        </section>

        <aside className="run-inspector">
          <div className="inspector-heading">
            <span className="eyebrow">{t("RUN INSPECTOR")}</span>
            <button className="icon-button" type="button">
              <MoreHorizontal size={17} />
            </button>
          </div>
          <div className="inspector-section">
            <h3>{t("Current run")}</h3>
            <div className="run-status">
              <span className={isStreaming ? "pulse" : ""}>
                <Zap size={15} />
              </span>
              <div>
                <strong>{isStreaming ? t("Processing") : t("Ready")}</strong>
                <small>
                  {isStreaming ? t("Streaming from Workers AI") : t("Waiting for a message")}
                </small>
              </div>
            </div>
          </div>
          <div className="inspector-section">
            <h3>{t("Steps")}</h3>
            <div className="timeline">
              <div className="complete">
                <span>
                  <Check size={12} />
                </span>
                <p>
                  <strong>{t("Authenticate")}</strong>
                  <small>{t("Workspace access verified")}</small>
                </p>
              </div>
              <div className={messages.length ? "complete" : "active"}>
                <span>{messages.length ? <Check size={12} /> : "2"}</span>
                <p>
                  <strong>{t("Reserve credits")}</strong>
                  <small>{t("Idempotent ledger entry")}</small>
                </p>
              </div>
              <div className={isStreaming ? "active" : ""}>
                <span>3</span>
                <p>
                  <strong>{t("Run agent")}</strong>
                  <small>{t("Tools and model stream")}</small>
                </p>
              </div>
              <div>
                <span>4</span>
                <p>
                  <strong>{t("Settle usage")}</strong>
                  <small>{t("Commit actual cost")}</small>
                </p>
              </div>
            </div>
          </div>
          <div className="inspector-section run-metrics">
            <h3>{t("Usage")}</h3>
            <div>
              <span>
                <Coins size={14} /> {t("Messages")}
              </span>
              <strong>{messages.filter((message) => message.role === "user").length}</strong>
            </div>
            <div>
              <span>
                <Zap size={14} /> {t("Model")}
              </span>
              <strong>{chat.model.split("/").at(-1)}</strong>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
