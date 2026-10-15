import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { TextStreamer, InterruptableStoppingCriteria } from "@huggingface/transformers";

import { useCapabilities, recommendModel, type WebCapabilities } from "../shared/capabilities";
import { acquirePipeline, type AcquireHandle, type DownloadProgress } from "../shared/modelLoader";
import { readPref, writePref } from "../shared/storage";
import { Badge, DownloadCard, StatusPill, type StatusKind } from "../shared/ui";

/* -------------------------------------------------------------------------- */
/*  Model catalog                                                             */
/* -------------------------------------------------------------------------- */

interface ChatModel {
  id: string;
  label: string;
  size: string;
  kind: "base" | "instruct";
  note: string;
}

const MODELS: ChatModel[] = [
  {
    id: "Xenova/distilgpt2",
    label: "DistilGPT-2",
    size: "~40 MB",
    kind: "base",
    note: "Raw LM — continues text. Smallest & fastest.",
  },
  {
    id: "onnx-community/SmolLM2-135M-Instruct-ONNX",
    label: "SmolLM2 135M",
    size: "~80 MB (q4)",
    kind: "instruct",
    note: "Follows instructions. Good on low-end devices.",
  },
  {
    id: "onnx-community/Qwen2.5-0.5B-Instruct",
    label: "Qwen2.5 0.5B",
    size: "~280 MB (q4)",
    kind: "instruct",
    note: "Better reasoning. Best with WebGPU.",
  },
  {
    id: "onnx-community/Qwen2.5-1.5B-Instruct",
    label: "Qwen2.5 1.5B",
    size: "~1 GB (q4)",
    kind: "instruct",
    note: "Noticeably smarter. Needs WebGPU.",
  },
];

type TextGenerator = ((input: string, options?: unknown) => Promise<unknown>) & {
  tokenizer: {
    apply_chat_template?: (messages: unknown, options: unknown) => string;
    encode?: (text: string) => number[];
  };
};

interface TokenRate {
  tps: number;
  tokens: number;
  cold: boolean;
  at: number;
}

const rateKey = (modelId: string) => `tps:v1:${modelId}`;

/* -------------------------------------------------------------------------- */
/*  Chat types, defaults & helpers                                            */
/* -------------------------------------------------------------------------- */

type Role = "system" | "user" | "assistant";

interface ChatMessage {
  role: Role;
  content: string;
}

interface ChatSettings {
  temperature: number;
  topP: number;
  maxNewTokens: number;
  repetitionPenalty: number;
}

const DEFAULT_SETTINGS: ChatSettings = {
  temperature: 0.6,
  topP: 0.95,
  maxNewTokens: 256,
  repetitionPenalty: 1.15,
};

const SETTINGS_KEY = "chat:settings:v1";
const SYSTEM_KEY = "chat:system:v1";

/**
 * Rough token budget for the templated prompt. Oldest turns are dropped once the
 * conversation exceeds this, keeping generation inside small models' context.
 */
const INPUT_TOKEN_BUDGET = 1536;

const roleLabel = (role: Role) => (role === "user" ? "User" : role === "assistant" ? "Assistant" : "System");

/**
 * Render a conversation to a single prompt string. Instruct models go through
 * their own chat template (which is what gives the bot memory); anything else
 * falls back to a plain `User:/Assistant:` transcript.
 */
function buildPrompt(tokenizer: TextGenerator["tokenizer"], system: string, messages: ChatMessage[]): string {
  const convo: ChatMessage[] = system.trim() ? [{ role: "system", content: system.trim() }, ...messages] : messages;

  if (tokenizer.apply_chat_template) {
    try {
      return tokenizer.apply_chat_template(convo, { tokenize: false, add_generation_prompt: true });
    } catch {
      // Some templates reject unfamiliar roles — fall through to a naive format.
    }
  }

  return convo.map((m) => `${roleLabel(m.role)}: ${m.content}`).join("\n") + "\nAssistant:";
}

function countTokens(tokenizer: TextGenerator["tokenizer"], text: string): number {
  if (typeof tokenizer.encode === "function") {
    try {
      return tokenizer.encode(text).length;
    } catch {
      /* fall through to the estimate */
    }
  }
  // Rough fallback: ~4 characters per token.
  return Math.ceil(text.length / 4);
}

/** Trim the oldest turns until the templated prompt fits the input budget. */
function fitHistory(tokenizer: TextGenerator["tokenizer"], system: string, history: ChatMessage[], userText: string): ChatMessage[] {
  const convo: ChatMessage[] = [...history, { role: "user", content: userText }];
  while (convo.length > 1 && countTokens(tokenizer, buildPrompt(tokenizer, system, convo)) > INPUT_TOKEN_BUDGET) {
    convo.shift();
  }
  return convo;
}

/* -------------------------------------------------------------------------- */
/*  Small pieces                                                              */
/* -------------------------------------------------------------------------- */

function CapabilityStrip({ caps }: { caps: WebCapabilities | null }) {
  if (!caps) {
    return <span className="text-[11px] text-[var(--text-faint)]">Detecting device capabilities…</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge
        tone={caps.webgpu ? "good" : "warn"}
        title={caps.webgpu ? "WebGPU available — larger models run much faster." : "WebGPU not available — falling back to WASM. Larger models will be slow."}
      >
        {caps.webgpu ? "WebGPU ready" : "WebGPU unavailable (WASM)"}
      </Badge>
      {caps.threads ? <Badge title="navigator.hardwareConcurrency — often capped by the browser.">{caps.threads} threads</Badge> : null}
      {caps.memoryGB ? <Badge title="navigator.deviceMemory — Chrome-only and capped at 8.">≥{caps.memoryGB} GB RAM</Badge> : null}
      {caps.mobile ? <Badge>mobile</Badge> : null}
      {caps.adapter?.architecture ? <Badge>{caps.adapter.architecture}</Badge> : null}
    </div>
  );
}

function TokenRateBadge({ modelId, version }: { modelId: string; version: number }) {
  const rate = useMemo(() => readPref<TokenRate>(rateKey(modelId)), [modelId, version]);

  if (!rate) return <span className="text-[11px] text-[var(--text-faint)]">not tried</span>;

  const cls = rate.tps > 10 ? "text-emerald-600 dark:text-emerald-400" : rate.tps > 3 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400";

  return (
    <span
      title={rate.cold ? "First run of this model this session — usually slower than warm runs." : `Last measured over ${rate.tokens} generated tokens.`}
      className={`mono text-[11px] font-medium ${cls}`}
    >
      {rate.cold ? "~" : ""}
      {rate.tps.toFixed(1)} tok/s
    </span>
  );
}

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

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}

function Slider({ label, value, min, max, step, format, onChange }: SliderProps) {
  return (
    <label className="block">
      <span className="mono mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-[var(--text-faint)]">
        <span>{label}</span>
        <span className="text-[var(--text-muted)]">{format ? format(value) : value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--text)]" />
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

type Phase = "idle" | "loading" | "ready" | "error";

export default function ChatPage() {
  const caps = useCapabilities();
  const recommended = recommendModel(caps);

  const aliveRef = useRef(true);
  const generatorRef = useRef<TextGenerator | null>(null);
  const warmRef = useRef(new Set<string>());
  const stopperRef = useRef<InterruptableStoppingCriteria | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const [modelId, setModelId] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Pick a model to get started.");
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadProgress | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveTps, setLiveTps] = useState<number | null>(null);
  const [rateVersion, setRateVersion] = useState(0);

  const [system, setSystem] = useState<string>(() => readPref<string>(SYSTEM_KEY) ?? "");
  const [settings, setSettings] = useState<ChatSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...(readPref<Partial<ChatSettings>>(SETTINGS_KEY) ?? {}),
  }));

  const chatModels = useMemo(() => MODELS.filter((m) => m.kind === "instruct"), []);
  const highlightedId = modelId ?? recommended;
  const selected = useMemo(() => MODELS.find((m) => m.id === highlightedId) ?? chatModels[0], [highlightedId, chatModels]);

  const phase: Phase = error ? "error" : modelId && caps && ready ? "ready" : modelId && caps ? "loading" : "idle";

  const pillStatus: StatusKind = phase === "error" ? "error" : phase === "ready" ? "ready" : phase === "loading" ? "downloading" : "idle";
  const pillLabel = phase === "error" ? "Failed" : phase === "ready" ? "Ready" : phase === "loading" ? "Loading" : "Idle";

  // Persist system prompt + generation settings.
  useEffect(() => {
    writePref(SYSTEM_KEY, system);
  }, [system]);
  useEffect(() => {
    writePref(SETTINGS_KEY, settings);
  }, [settings]);

  /* ----------------------------- model loading ---------------------------- */

  useEffect(() => {
    // Idle until the user picks a model — and until capability detection is done,
    // so we only build the pipeline once, with the right device.
    if (!caps || !modelId) return;

    aliveRef.current = true;
    let cancelled = false;
    let current: AcquireHandle | null = null;

    const run = async () => {
      setReady(false);
      setError(null);
      setDownload(null);
      setStatus("Loading model…");

      const onProgress = (progress: DownloadProgress) => {
        if (!cancelled) setDownload(progress);
      };

      const tryDevice = async (device: "webgpu" | "wasm") => {
        current = acquirePipeline("text-generation", modelId, {
          device,
          dtype: "q4",
          onProgress,
        });
        try {
          return await current.result;
        } catch (err) {
          current.release();
          current = null;
          throw err;
        }
      };

      try {
        let instance: TextGenerator;
        if (caps.webgpu) {
          try {
            instance = (await tryDevice("webgpu")) as TextGenerator;
          } catch {
            if (cancelled) return;
            setStatus("WebGPU unavailable — using WASM…");
            instance = (await tryDevice("wasm")) as TextGenerator;
          }
        } else {
          instance = (await tryDevice("wasm")) as TextGenerator;
        }

        if (cancelled) return;
        generatorRef.current = instance;
        setReady(true);
        setStatus("Model ready. Say something.");
      } catch (err) {
        if (cancelled) return;
        generatorRef.current = null;
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        setStatus("Failed to load: " + message);
      }
    };

    void run();

    // Cancel in-flight work + dispose the pipeline on switch/unmount.
    return () => {
      cancelled = true;
      aliveRef.current = false;
      stopperRef.current?.interrupt();
      current?.release();
      current = null;
      generatorRef.current = null;
    };
  }, [modelId, caps, retryNonce]);

  /* -------------------------------- controls ------------------------------- */

  const pickModel = (id: string) => {
    if (busy) return;

    if (id === modelId) {
      if (!error) return; // already active & healthy
      setRetryNonce((n) => n + 1); // re-run the failed load
      return;
    }

    if (messages.length > 0) {
      const ok = typeof window === "undefined" || window.confirm("Switching models starts a new conversation. Continue?");
      if (!ok) return;
    }

    setModelId(id);
    setMessages([]);
    setStreaming("");
    setInput("");
  };

  const newChat = () => {
    setMessages([]);
    setStreaming("");
    setInput("");
  };

  const stop = () => stopperRef.current?.interrupt();

  /* -------------------------------- generate ------------------------------- */

  const send = useCallback(async () => {
    const generator = generatorRef.current;
    const text = input.trim();
    if (!generator || !text || busy || !ready || !modelId) return;

    const history = messages;
    const turns = fitHistory(generator.tokenizer, system, history, text);
    const isCold = !warmRef.current.has(modelId);

    setMessages([...history, { role: "user", content: text }]);
    setInput("");
    setBusy(true);
    setStreaming("");
    setLiveTps(null);

    const stopper = new InterruptableStoppingCriteria();
    stopperRef.current = stopper;

    let firstTokenAt = 0;
    let lastTokenAt = 0;
    let tokenCount = 0;
    let acc = "";
    let failure: string | null = null;

    try {
      const streamer = new TextStreamer(generator.tokenizer as never, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (token: string) => {
          const now = performance.now();
          if (!firstTokenAt) firstTokenAt = now;
          lastTokenAt = now;
          tokenCount++;
          acc += token;
          if (!aliveRef.current) return;
          setStreaming(acc);
          if (tokenCount >= 2 && lastTokenAt > firstTokenAt) {
            setLiveTps(((tokenCount - 1) * 1000) / (lastTokenAt - firstTokenAt));
          }
        },
      });

      const promptText = buildPrompt(generator.tokenizer, system, turns);

      await generator(promptText, {
        max_new_tokens: settings.maxNewTokens,
        do_sample: settings.temperature > 0,
        temperature: settings.temperature,
        top_p: settings.topP,
        repetition_penalty: settings.repetitionPenalty,
        streamer,
        stopping_criteria: stopper,
      });

      if (tokenCount >= 2 && lastTokenAt > firstTokenAt) {
        const tps = ((tokenCount - 1) * 1000) / (lastTokenAt - firstTokenAt);
        writePref<TokenRate>(rateKey(modelId), { tps, tokens: tokenCount, cold: isCold, at: Date.now() });
        if (aliveRef.current) setRateVersion((v) => v + 1);
      }
      warmRef.current.add(modelId);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      if (aliveRef.current) {
        const content = failure ? (acc ? `${acc}\n\n[error: ${failure}]` : `Error: ${failure}`) : acc;
        if (content.trim()) setMessages((prev) => [...prev, { role: "assistant", content }]);
        setStreaming("");
        setLiveTps(null);
        setBusy(false);
      }
      stopperRef.current = null;
    }
  }, [input, busy, ready, messages, modelId, system, settings]);

  /** Enter sends; Shift+Enter inserts a newline. Guarded against IME composition. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    const native = event.nativeEvent;
    if (native.isComposing || native.keyCode === 229) return; // IME composition guard
    event.preventDefault();
    void send();
  };

  // Follow the tail of the transcript as it streams.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  const loadingModel = phase === "loading";
  const showSettings = phase === "ready";

  return (
    <div className="flex w-full flex-1 flex-col items-center">
      <div className="flex w-full max-w-[760px] flex-col px-6 pb-16 pt-10 md:pt-14">
        <header className="mb-8">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="display text-[32px] leading-[0.95] tracking-[-0.03em] md:text-[40px]">Chat, in your browser.</h1>
            <StatusPill status={pillStatus}>{pillLabel}</StatusPill>
          </div>
          <p className="mt-3 max-w-[52ch] text-[14px] leading-6 text-[var(--text-muted)]">
            Pick a model to load it, then chat. Runs client-side with Transformers.js — first load downloads the model, afterwards it's cached and works offline. Prompts never leave the tab.
          </p>
        </header>

        {/* Device capability strip */}
        <section className="mb-6">
          <div className="mono mb-2 text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Your device</div>
          <CapabilityStrip caps={caps} />
        </section>

        {/* Model picker */}
        <section className="mb-6">
          <div className="mono mb-2 text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Model</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {chatModels.map((model) => {
              const active = model.id === highlightedId;
              const isRecommended = model.id === recommended;
              const isCurrent = model.id === modelId;
              return (
                <button
                  key={model.id}
                  onClick={() => pickModel(model.id)}
                  disabled={busy}
                  className={`flex flex-col rounded-[16px] border p-3.5 text-left transition ${
                    active ? "border-[var(--text)] bg-[var(--surface)] ring-1 ring-[var(--text)]" : "border-[var(--border)] bg-[var(--bg-soft)] hover:border-[var(--border-strong)]"
                  } ${busy ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-[14px] font-[550] tracking-[-0.01em]">{model.label}</span>
                    <TokenRateBadge modelId={model.id} version={rateVersion} />
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    {isRecommended ? <Badge tone="good">recommended</Badge> : null}
                    {isCurrent && ready ? <Badge tone="invert">active</Badge> : null}
                    {isCurrent && loadingModel ? <Badge tone="warn">loading…</Badge> : null}
                  </div>
                  <span className="mono mt-2 text-[11px] leading-4 text-[var(--text-muted)]">
                    {model.size} · {model.note}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Download progress */}
        {loadingModel && download && download.overall < 100 ? (
          <section className="mb-6">
            <DownloadCard
              modelLabel={modelId ?? undefined}
              sizeLabel={selected.size}
              progress={download}
              footer={
                <span className="mono flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                  Downloading from Hugging Face • cached in browser
                </span>
              }
            />
          </section>
        ) : null}

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
                    onClick={() => setSettings(DEFAULT_SETTINGS)}
                    className="mono rounded-full border border-[var(--border)] px-3 py-1 text-[10px] tracking-wide text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                  >
                    Reset defaults
                  </button>
                </div>
              </div>
            </details>
          </section>
        ) : null}

        {/* Status */}
        <p className={`mono mb-4 text-[11px] ${error ? "text-red-600 dark:text-red-400" : "text-[var(--text-faint)]"}`}>{status}</p>

        {/* Transcript */}
        {showSettings ? (
          <section className="mb-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge tone="invert">{selected.label}</Badge>
                {busy && liveTps != null ? <span className="mono text-[11px] text-[var(--text-muted)]">{liveTps.toFixed(1)} tok/s</span> : null}
                {busy && liveTps == null ? <span className="mono text-[11px] text-[var(--text-faint)]">thinking…</span> : null}
              </div>
              <button
                onClick={newChat}
                disabled={busy || messages.length === 0}
                className="mono text-[10px] uppercase tracking-widest text-[var(--text-faint)] transition hover:text-[var(--text)] disabled:opacity-40"
              >
                New chat
              </button>
            </div>

            <div className="max-h-[52vh] min-h-[140px] overflow-y-auto rounded-[20px] border border-[var(--border)] bg-[var(--bg-soft)] p-4">
              {messages.length === 0 && !streaming ? <p className="text-[13px] text-[var(--text-faint)]">{system.trim() ? "System prompt set. " : ""}Ask anything to start the conversation.</p> : null}

              <div className="flex flex-col gap-3">
                {messages.map((m, i) => (
                  <Bubble key={i} role={m.role} content={m.content} />
                ))}
                {busy ? <Bubble role="assistant" content={streaming} streaming /> : null}
              </div>
              <div ref={endRef} />
            </div>
          </section>
        ) : null}

        {/* Composer */}
        <section className="mb-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={showSettings ? "Message…  (Enter to send, Shift+Enter for newline)" : "Pick a model above to start"}
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
