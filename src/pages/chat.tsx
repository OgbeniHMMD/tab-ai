import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { Link, Navigate } from "react-router-dom";

import { MODELS, useChatSession, type Role } from "../shared/chatSession";
import { Badge, Slider, StatusPill, type StatusKind } from "../shared/ui";

/* -------------------------------------------------------------------------- */
/*  Small pieces                                                              */
/* -------------------------------------------------------------------------- */

function Bubble({ role, content, streaming = false }: { role: Role; content: string; streaming?: boolean }) {
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

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function ChatPage() {
  const {
    modelId,
    ready,
    error,
    status,
    phase,
    messages,
    system,
    setSystem,
    settings,
    setSettings,
    resetSettings,
    activeSkillIds,
    input,
    setInput,
    streaming,
    busy,
    liveTps,
    send,
    stop,
    retry,
    newChat,
  } = useChatSession();

  const endRef = useRef<HTMLDivElement | null>(null);

  // Follow the tail of the transcript as it streams.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  // No model loaded yet — send the user to the catalog to pick one.
  if (!modelId) return <Navigate to="/models" replace />;

  const model = MODELS.find((m) => m.id === modelId) ?? MODELS[0];
  const pillStatus: StatusKind = phase === "error" ? "error" : phase === "ready" ? "ready" : phase === "loading" ? "downloading" : "idle";
  const pillLabel = phase === "error" ? "Failed" : phase === "ready" ? "Ready" : phase === "loading" ? "Loading" : "Idle";
  const showSettings = phase === "ready";

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    const native = event.nativeEvent;
    if (native.isComposing || native.keyCode === 229) return; // IME composition guard
    event.preventDefault();
    void send();
  };

  return (
    <div className="flex w-full flex-1 flex-col items-center">
      <div className="flex w-full max-w-[760px] flex-col px-6 pb-16 pt-8">
        {/* Compact header: current model + change / new chat */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge tone="invert">{model.label}</Badge>
            <StatusPill status={pillStatus}>{pillLabel}</StatusPill>
            {activeSkillIds.length > 0 ? (
              <Badge tone="info">
                {activeSkillIds.length} skill{activeSkillIds.length > 1 ? "s" : ""}
              </Badge>
            ) : null}
            {busy && liveTps != null ? <span className="mono text-[11px] text-[var(--text-muted)]">{liveTps.toFixed(1)} tok/s</span> : null}
            {busy && liveTps == null ? <span className="mono text-[11px] text-[var(--text-faint)]">thinking…</span> : null}
          </div>
          <div className="flex items-center gap-3">
            <Link to="/models" className="mono text-[10px] uppercase tracking-widest text-[var(--text-faint)] transition hover:text-[var(--text)]">
              Change
            </Link>
            <Link to="/settings" className="mono text-[10px] uppercase tracking-widest text-[var(--text-faint)] transition hover:text-[var(--text)]">
              Settings
            </Link>
            <button
              onClick={newChat}
              disabled={busy || messages.length === 0}
              className="mono text-[10px] uppercase tracking-widest text-[var(--text-faint)] transition hover:text-[var(--text)] disabled:opacity-40"
            >
              New chat
            </button>
          </div>
        </header>

        {/* System prompt + generation settings */}
        {showSettings ? (
          <section className="mb-4">
            <details className="group rounded-[16px] border border-[var(--border)] bg-[var(--bg-soft)]">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3">
                <span className="mono text-[10px] uppercase tracking-widest text-[var(--text-faint)]">System &amp; settings</span>
                <span className="flex items-center gap-2">
                  {system.trim() ? <Badge tone="info">system set</Badge> : null}
                  <span className="mono text-[10px] text-[var(--text-faint)]">
                    temp {settings.temperature.toFixed(2)} · {settings.maxNewTokens} tok
                  </span>
                  <span className="text-[var(--text-faint)] transition group-open:rotate-180">▾</span>
                </span>
              </summary>

              <div className="space-y-4 border-t border-[var(--border)] px-4 py-4">
                <div>
                  <label className="mono mb-1.5 block text-[10px] uppercase tracking-widest text-[var(--text-faint)]">System prompt</label>
                  <textarea
                    value={system}
                    onChange={(e) => setSystem(e.target.value)}
                    rows={3}
                    placeholder="Optional. Sets the assistant's role, tone, or rules. Small models follow this loosely."
                    className="mono w-full resize-y rounded-[12px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[12px] leading-5 text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--text)] focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Slider
                    label="Temperature"
                    value={settings.temperature}
                    min={0}
                    max={1.5}
                    step={0.05}
                    format={(v) => v.toFixed(2)}
                    onChange={(v) => setSettings((s) => ({ ...s, temperature: v }))}
                  />
                  <Slider label="Top-p" value={settings.topP} min={0.1} max={1} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => setSettings((s) => ({ ...s, topP: v }))} />
                  <Slider label="Max new tokens" value={settings.maxNewTokens} min={64} max={1024} step={32} onChange={(v) => setSettings((s) => ({ ...s, maxNewTokens: v }))} />
                  <Slider
                    label="Repetition penalty"
                    value={settings.repetitionPenalty}
                    min={1}
                    max={1.5}
                    step={0.05}
                    format={(v) => v.toFixed(2)}
                    onChange={(v) => setSettings((s) => ({ ...s, repetitionPenalty: v }))}
                  />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <span className="mono text-[10px] text-[var(--text-faint)]">Non-zero temperature enables sampling.</span>
                  <button
                    onClick={resetSettings}
                    className="mono rounded-full border border-[var(--border)] px-3 py-1 text-[10px] tracking-wide text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                  >
                    Reset defaults
                  </button>
                </div>
              </div>
            </details>
          </section>
        ) : null}

        {/* Status + resume control, when the model isn't ready yet */}
        {!showSettings ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3">
            <p className={`mono text-[11px] ${error ? "text-red-600 dark:text-red-400" : "text-[var(--text-faint)]"}`}>{status}</p>
            {phase === "loading" ? (
              <span className="mono flex items-center gap-2 text-[10px] text-[var(--text-faint)]">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                loading…
              </span>
            ) : (
              <button
                onClick={retry}
                className="mono rounded-full border border-[var(--border)] px-3 py-1 text-[10px] uppercase tracking-widest text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
              >
                Reload model
              </button>
            )}
          </div>
        ) : null}

        {/* Transcript */}
        <section className="mb-3">
          <div className="max-h-[56vh] min-h-[160px] overflow-y-auto rounded-[20px] border border-[var(--border)] bg-[var(--bg-soft)] p-4">
            {messages.length === 0 && !streaming && ready ? (
              <p className="text-[13px] text-[var(--text-faint)]">{system.trim() ? "System prompt set. " : ""}Ask anything to start the conversation.</p>
            ) : null}
            {messages.length === 0 && !streaming && !ready ? (
              <p className="text-[13px] text-[var(--text-faint)]">
                {error ? "Model failed to load. " : phase === "loading" ? "Preparing the model… " : "Model is idle. "}
                <Link to="/models" className="underline underline-offset-2">
                  Back to models
                </Link>
              </p>
            ) : null}

            <div className="flex flex-col gap-3">
              {messages.map((m, i) => (
                <Bubble key={i} role={m.role} content={m.content} />
              ))}
              {busy ? <Bubble role="assistant" content={streaming} streaming /> : null}
            </div>
            <div ref={endRef} />
          </div>
        </section>

        {/* Composer */}
        <section className="mb-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={showSettings ? "Message…  (Enter to send, Shift+Enter for newline)" : "Waiting for the model…"}
              disabled={!showSettings || busy}
              className="mono max-h-[160px] min-h-[42px] flex-1 resize-none rounded-[12px] border border-[var(--border)] bg-[var(--bg-soft)] px-3.5 py-2.5 text-[13px] text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--text)] focus:outline-none disabled:opacity-50"
            />
            {busy ? (
              <button onClick={stop} className="rounded-[12px] border border-[var(--border-strong)] px-5 py-2.5 text-[13px] font-[500] text-[var(--text)] transition hover:border-[var(--text)]">
                Stop
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={!showSettings || !input.trim()}
                className="rounded-[12px] bg-[var(--text)] px-5 py-2.5 text-[13px] font-[500] text-[var(--bg)] transition hover:opacity-[0.9] disabled:cursor-not-allowed disabled:opacity-30"
              >
                Send
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
