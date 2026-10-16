import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";

import { MODELS, useChatSession, type Role } from "../shared/chatSession";
import { conversationToText, formatTimestamp, type Conversation } from "../shared/conversations";
import { COMMANDS, PROMPTS } from "../shared/prompts";
import { Badge, LoadingDialog, StatusPill, useDismissibleLoader, type StatusKind } from "../shared/ui";

/* -------------------------------------------------------------------------- */
/*  Icons                                                                     */
/* -------------------------------------------------------------------------- */

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const PencilIcon = () => (
  <svg {...iconProps}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const ExportIcon = () => (
  <svg {...iconProps}>
    <path d="M12 15V3" />
    <path d="m7 8 5-5 5 5" />
    <path d="M5 21h14" />
  </svg>
);
const ExpandIcon = () => (
  <svg {...iconProps}>
    <path d="M4 9V4h5" />
    <path d="M20 15v5h-5" />
    <path d="M15 4h5v5" />
    <path d="M9 20H4v-5" />
  </svg>
);
const PlusIcon = () => (
  <svg {...iconProps}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const MenuIcon = () => (
  <svg {...iconProps}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </svg>
);
const TrashIcon = () => (
  <svg {...iconProps} width={14} height={14}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </svg>
);
const SendIcon = () => (
  <svg {...iconProps}>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4Z" />
  </svg>
);

/* -------------------------------------------------------------------------- */
/*  Small pieces                                                              */
/* -------------------------------------------------------------------------- */

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function Bubble({ role, content, streaming = false }: { role: Role; content: string; streaming?: boolean }) {
  if (role === "system") {
    return (
      <div className="flex flex-col items-start gap-1">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-[16px] border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
          {content}
        </div>
        <span className="mono pl-1 text-[10px] uppercase tracking-widest text-[var(--text-faint)]">System Prompt</span>
      </div>
    );
  }
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-[16px] px-3.5 py-2.5 text-[13px] leading-relaxed ${
          isUser ? "bg-[var(--text)] text-[var(--bg)]" : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
        }`}
      >
        {content}
        {streaming ? <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-current align-text-bottom" /> : null}
      </div>
    </div>
  );
}

function ConversationRow({ conv, active, onSelect, onDelete }: { conv: Conversation; active: boolean; onSelect: () => void; onDelete: () => void }) {
  return (
    <div
      className={`group relative w-full rounded-[14px] border px-3.5 py-3 text-left transition ${
        active ? "border-[var(--text)] bg-[var(--surface)] shadow-[0_1px_0_rgba(0,0,0,0.03)]" : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)]"
      }`}
    >
      <button type="button" onClick={onSelect} className="block w-full text-left">
        <div className="truncate pr-6 text-[13.5px] font-[550] tracking-[-0.01em] text-[var(--text)]">{conv.title}</div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="mono text-[10.5px] text-[var(--text-faint)]">
            {conv.messages.length} message{conv.messages.length === 1 ? "" : "s"}
          </span>
          <span className="mono text-[10px] text-[var(--text-faint)]">{formatTimestamp(conv.updatedAt)}</span>
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label="Delete conversation"
        title="Delete conversation"
        className="absolute right-2 top-2.5 hidden rounded-full p-1 text-[var(--text-faint)] transition hover:bg-[var(--bg-soft)] hover:text-red-600 group-hover:block dark:hover:text-red-400"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

interface PaletteItem {
  key: string;
  label: string;
  description: string;
  hint: string;
  onPick: () => void;
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function ChatPage() {
  const navigate = useNavigate();
  const {
    modelId,
    ready,
    error,
    status,
    download,
    phase,
    messages,
    conversation,
    conversationSystem,
    setConversationSystem,
    conversations,
    hydrated,
    activeSkillIds,
    input,
    setInput,
    streaming,
    busy,
    liveTps,
    send,
    stop,
    newChat,
    selectConversation,
    renameConversation,
    deleteConversation,
    clearMessages,
  } = useChatSession();

  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // `null` = closed; otherwise which field the edit dialog should focus.
  const [editor, setEditor] = useState<null | "title" | "system">(null);
  const [selected, setSelected] = useState(0);

  const loading = useDismissibleLoader(phase === "loading");

  // Follow the tail of the transcript as it streams.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  // Keep the composer ready to type into, without yanking focus from a field
  // the user is already editing.
  useEffect(() => {
    if (phase !== "ready" || busy) return;
    const active = document.activeElement;
    const editing = active instanceof HTMLElement && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
    if (!editing) inputRef.current?.focus({ preventScroll: true });
  }, [phase, busy]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  /* ------------------------------ palette ---------------------------------- */

  // The `/` prompt library and `;` command palette are *derived* from the
  // composer text, so there's no separate open/close state to keep in sync.
  const palette = useMemo(() => {
    if (input.includes("\n")) return null;
    if (input.startsWith("/")) return { kind: "prompt" as const, query: input.slice(1).toLowerCase() };
    if (input.startsWith(";")) return { kind: "command" as const, query: input.slice(1).toLowerCase() };
    return null;
  }, [input]);

  const applyPrompt = (text: string) => {
    setInput(text);
    const el = inputRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    }
  };

  const runCommand = useMemo(() => {
    const handlers: Record<string, () => void> = {
      new: () => newChat(),
      clear: () => clearMessages(),
      rename: () => setEditor("title"),
      system: () => setEditor("system"),
      models: () => navigate("/models"),
      settings: () => navigate("/settings"),
      stop: () => stop(),
    };
    return (name: string) => {
      handlers[name]?.();
      if (handlers[name]) setInput("");
    };
  }, [newChat, clearMessages, navigate, stop, setInput]);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    if (!palette) return [];
    const q = palette.query;
    if (palette.kind === "prompt") {
      return PROMPTS.filter((p) => p.label.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)).map((p) => ({
        key: p.id,
        label: p.label,
        description: p.description,
        hint: "/",
        onPick: () => applyPrompt(p.text),
      }));
    }
    return COMMANDS.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)).map((c) => ({
      key: c.name,
      label: `;${c.name}`,
      description: c.description,
      hint: ";",
      onPick: () => runCommand(c.name),
    }));
    // Only the palette text drives which items show; the pick handlers are
    // recreated each render but always close over the current state.
  }, [palette, runCommand]);

  useEffect(() => {
    setSelected(0);
  }, [palette?.kind, palette?.query]);

  /* ------------------------------ handlers --------------------------------- */

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (palette && paletteItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((s) => (s + 1) % paletteItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((s) => (s - 1 + paletteItems.length) % paletteItems.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setInput("");
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const native = event.nativeEvent;
        if (native.isComposing || native.keyCode === 229) return;
        event.preventDefault();
        paletteItems[Math.min(selected, paletteItems.length - 1)].onPick();
        return;
      }
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    const native = event.nativeEvent;
    if (native.isComposing || native.keyCode === 229) return; // IME composition guard
    event.preventDefault();
    void send();
  };

  const onExport = () => {
    if (!conversation) return;
    const safe =
      conversation.title
        .replace(/[^\w.-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "conversation";
    downloadText(`${safe}.md`, conversationToText(conversation));
  };

  const onToggleFullscreen = () => {
    const el = cardRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  // No model loaded yet — send the user to the catalog to pick one.
  if (!modelId) return <Navigate to="/models" replace />;

  const model = MODELS.find((m) => m.id === modelId) ?? MODELS[0];
  const pillStatus: StatusKind = phase === "error" ? "error" : phase === "ready" ? "ready" : phase === "loading" ? "downloading" : "idle";
  const pillLabel = phase === "error" ? "Failed" : phase === "ready" ? "Ready" : phase === "loading" ? "Loading" : "Idle";
  const canCompose = phase === "ready" && !busy;

  return (
    <div className="flex h-[calc(100vh_-_112px_-_var(--safe-area-inset-top))] min-h-[520px] w-full flex-col items-center px-3 py-4 md:px-6 md:py-6">
      <div
        ref={cardRef}
        className={`relative flex h-full min-h-0 w-full max-w-[1200px] overflow-hidden border border-[var(--border)] bg-[var(--surface)] ${fullscreen ? "rounded-none" : "rounded-[24px]"}`}
      >
        {/* ---------------------------------------------------------------- */}
        {/* Sidebar                                                          */}
        {/* ---------------------------------------------------------------- */}
        {sidebarOpen ? <div className="absolute inset-0 z-10 bg-black/30 md:hidden" onClick={() => setSidebarOpen(false)} /> : null}

        <aside
          className={`${sidebarOpen ? "flex" : "hidden"} absolute inset-y-0 left-0 z-20 w-[290px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-soft)] md:static md:z-auto md:flex`}
        >
          <div className="flex items-center gap-3 px-5 pb-4 pt-5">
            <div className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-[var(--text)] text-[13px] font-semibold text-[var(--bg)]">T</div>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-[600] tracking-[-0.02em]">Local Chat</div>
              <div className="mono text-[10px] uppercase tracking-widest text-[var(--text-faint)]">On-device · Private</div>
            </div>
          </div>

          <div className="flex gap-2 px-5">
            <button
              type="button"
              onClick={() => {
                applyPrompt("/");
                setSidebarOpen(false);
              }}
              className="mono flex-1 rounded-[11px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[11px] tracking-wide text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            >
              / Prompts
            </button>
            <Link
              to="/settings"
              className="mono flex-1 rounded-[11px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-center text-[11px] tracking-wide text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            >
              Settings
            </Link>
          </div>

          <div className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto px-5 pb-4">
            {conversations.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === conversation?.id}
                onSelect={() => {
                  selectConversation(c.id);
                  setSidebarOpen(false);
                }}
                onDelete={() => deleteConversation(c.id)}
              />
            ))}
            {!hydrated && conversations.length === 0 ? <p className="mono px-1 text-[11px] text-[var(--text-faint)]">Loading conversations…</p> : null}
          </div>

          <div className="border-t border-[var(--border)] px-5 py-4">
            <button
              type="button"
              onClick={() => {
                newChat();
                setSidebarOpen(false);
              }}
              disabled={busy}
              className="mono flex w-full items-center justify-center gap-2 rounded-[12px] bg-[var(--text)] px-4 py-2.5 text-[12px] font-[500] tracking-wide text-[var(--bg)] transition hover:opacity-[0.9] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <PlusIcon /> New Chat
            </button>
          </div>
        </aside>

        {/* ---------------------------------------------------------------- */}
        {/* Main pane                                                        */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3.5 md:px-6 md:py-4">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open conversations"
                className="rounded-[10px] border border-[var(--border)] p-2 text-[var(--text-muted)] transition hover:text-[var(--text)] md:hidden"
              >
                <MenuIcon />
              </button>
              <div className="min-w-0">
                <h1 className="truncate text-[18px] font-[600] tracking-[-0.02em] md:text-[20px]">{conversation?.title ?? "New Conversation"}</h1>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="mono text-[11px] text-[var(--text-faint)]">
                    {messages.length} message{messages.length === 1 ? "" : "s"}
                  </span>
                  {busy && liveTps != null ? <span className="mono text-[10px] text-[var(--text-faint)]">{liveTps.toFixed(1)} tok/s</span> : null}
                  {busy && liveTps == null ? <span className="mono text-[10px] text-[var(--text-faint)]">thinking…</span> : null}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setEditor("system")}
                disabled={!conversation}
                aria-label="Edit conversation"
                title="Edit conversation"
                className="rounded-[10px] border border-[var(--border)] p-2 text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)] disabled:opacity-40"
              >
                <PencilIcon />
              </button>
              <button
                type="button"
                onClick={onExport}
                disabled={!conversation || messages.length === 0}
                aria-label="Export conversation"
                title="Export as Markdown"
                className="rounded-[10px] border border-[var(--border)] p-2 text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)] disabled:opacity-40"
              >
                <ExportIcon />
              </button>
              <Link
                to="/models"
                title="Change model"
                className="mono hidden rounded-full border border-[var(--border)] px-3 py-1.5 text-[10.5px] text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)] sm:inline-flex"
              >
                {model.label}
              </Link>
              <button
                type="button"
                onClick={onToggleFullscreen}
                aria-label="Toggle fullscreen"
                title="Fullscreen"
                className="rounded-[10px] border border-[var(--border)] p-2 text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
              >
                <ExpandIcon />
              </button>
            </div>
          </header>

          {/* Status banner while the model isn't ready */}
          {!canCompose && !loading.open ? (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-soft)] px-4 py-2.5 md:px-6">
              <div className="flex items-center gap-2">
                <StatusPill status={pillStatus}>{pillLabel}</StatusPill>
                <p className={`mono text-[11px] ${error ? "text-red-600 dark:text-red-400" : "text-[var(--text-faint)]"}`}>{status}</p>
              </div>
              {phase === "loading" ? (
                <button
                  type="button"
                  onClick={loading.reopen}
                  className="mono rounded-full border border-[var(--border)] px-3 py-1 text-[10px] uppercase tracking-widest text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                >
                  Show progress
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Transcript */}
          <section className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
            <div className="mx-auto flex max-w-[760px] flex-col gap-4">
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => setEditor("system")}
                  disabled={!conversation}
                  className="mono inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-[11px] tracking-wide text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)] disabled:opacity-40"
                >
                  <PencilIcon /> Edit Conversation
                </button>
              </div>

              {conversationSystem.trim() ? <Bubble role="system" content={conversationSystem} /> : null}

              {messages.length === 0 && !busy && ready ? (
                <p className="text-[13px] text-[var(--text-faint)]">{conversationSystem.trim() ? "System prompt set. " : ""}Ask anything to start the conversation.</p>
              ) : null}

              {messages.map((m, i) => (
                <Bubble key={i} role={m.role} content={m.content} />
              ))}
              {busy ? <Bubble role="assistant" content={streaming} streaming /> : null}
              <div ref={endRef} />
            </div>
          </section>

          {/* Composer */}
          <section className="shrink-0 border-t border-[var(--border)] px-4 py-3.5 md:px-6 md:py-4">
            <div className="mx-auto max-w-[760px]">
              {palette && paletteItems.length > 0 ? (
                <div className="mb-2 max-h-[260px] overflow-y-auto rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-lg">
                  <div className="mono px-2.5 py-1.5 text-[10px] uppercase tracking-widest text-[var(--text-faint)]">{palette.kind === "prompt" ? "Prompts" : "Commands"}</div>
                  {paletteItems.map((item, i) => (
                    <button
                      key={item.key}
                      type="button"
                      onMouseEnter={() => setSelected(i)}
                      onClick={item.onPick}
                      className={`flex w-full items-center justify-between gap-3 rounded-[10px] px-2.5 py-2 text-left transition ${
                        i === selected ? "bg-[var(--bg-soft)]" : "hover:bg-[var(--bg-soft)]"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-[500] text-[var(--text)]">{item.label}</span>
                        <span className="block truncate text-[12px] text-[var(--text-muted)]">{item.description}</span>
                      </span>
                      <span className="mono shrink-0 text-[10px] text-[var(--text-faint)]">{item.hint}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="flex items-center gap-1.5 pb-2">
                <button
                  type="button"
                  onClick={() => setEditor("system")}
                  disabled={!conversation}
                  title="Edit conversation"
                  className="rounded-[9px] border border-[var(--border)] p-1.5 text-[var(--text-faint)] transition hover:text-[var(--text)] disabled:opacity-40"
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  onClick={() => applyPrompt("/")}
                  disabled={!canCompose}
                  className="mono rounded-[9px] border border-[var(--border)] px-2.5 py-1.5 text-[11px] text-[var(--text-faint)] transition hover:text-[var(--text)] disabled:opacity-40"
                >
                  /
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInput(";");
                    inputRef.current?.focus();
                  }}
                  disabled={!canCompose}
                  className="mono rounded-[9px] border border-[var(--border)] px-2.5 py-1.5 text-[11px] text-[var(--text-faint)] transition hover:text-[var(--text)] disabled:opacity-40"
                >
                  ;
                </button>
                <span className="mono ml-1 inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-[10.5px] text-[var(--text-muted)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  {model.label}
                </span>
                {activeSkillIds.length > 0 ? (
                  <Badge tone="info">
                    {activeSkillIds.length} skill{activeSkillIds.length > 1 ? "s" : ""}
                  </Badge>
                ) : null}
              </div>

              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  rows={3}
                  placeholder={canCompose ? "Enter to send, Shift + Enter to wrap, / to search prompts, ; to use commands" : "Waiting for the model…"}
                  disabled={!canCompose}
                  className="max-h-[240px] min-h-[76px] flex-1 resize-none rounded-[14px] border border-[var(--border)] bg-[var(--bg-soft)] px-3.5 py-3 text-[13px] leading-6 text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--text)] focus:outline-none disabled:opacity-50"
                />
                {busy ? (
                  <button onClick={stop} className="rounded-[12px] border border-[var(--border-strong)] px-5 py-3 text-[13px] font-[500] text-[var(--text)] transition hover:border-[var(--text)]">
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={() => void send()}
                    disabled={!canCompose || !input.trim()}
                    className="inline-flex items-center gap-2 rounded-[12px] bg-[var(--text)] px-5 py-3 text-[13px] font-[500] text-[var(--bg)] transition hover:opacity-[0.9] disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <SendIcon /> Send
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>

        {/* Edit dialog */}
        {editor && conversation ? (
          <EditConversationDialog
            conversation={conversation}
            initialFocus={editor}
            onRename={(title) => renameConversation(conversation.id, title)}
            onSystem={setConversationSystem}
            onClose={() => setEditor(null)}
          />
        ) : null}
      </div>

      {/* Full-screen popup while the model downloads + builds. */}
      <LoadingDialog open={loading.open} status={status} progress={download} modelLabel={model.label} sizeLabel={model.size} onClose={loading.dismiss} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Edit conversation dialog                                                  */
/* -------------------------------------------------------------------------- */

function EditConversationDialog({
  conversation,
  initialFocus,
  onRename,
  onSystem,
  onClose,
}: {
  conversation: Conversation;
  initialFocus: "title" | "system";
  onRename: (title: string) => void;
  onSystem: (value: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(conversation.title);
  const [system, setSystem] = useState(conversation.system);
  const systemRef = useRef<HTMLTextAreaElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (initialFocus === "system") systemRef.current?.focus();
    else titleRef.current?.focus();
  }, [initialFocus]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const commit = () => {
    onRename(title);
    onSystem(system);
    onClose();
  };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-[520px] rounded-[18px] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mono mb-4 text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Edit conversation</div>

        <label className="block">
          <span className="mono mb-1.5 block text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Title</span>
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-[12px] border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-2.5 text-[13px] text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--text)] focus:outline-none"
          />
        </label>

        <label className="mt-4 block">
          <span className="mono mb-1.5 block text-[10px] uppercase tracking-widest text-[var(--text-faint)]">System prompt</span>
          <textarea
            ref={systemRef}
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            rows={5}
            placeholder="Optional. Sets the assistant's role, tone, or rules for this conversation. Small models follow this loosely."
            className="mono w-full resize-y rounded-[12px] border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-2.5 text-[12px] leading-5 text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--text)] focus:outline-none"
          />
        </label>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="mono rounded-full border border-[var(--border)] px-3 py-1.5 text-[10px] uppercase tracking-widest text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
          >
            Cancel
          </button>
          <button type="button" onClick={commit} className="rounded-[10px] bg-[var(--text)] px-4 py-2 text-[12px] font-[500] text-[var(--bg)] transition hover:opacity-[0.9]">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
