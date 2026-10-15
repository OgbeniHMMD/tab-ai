import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { TextStreamer } from "@huggingface/transformers";

import { useCapabilities, recommendModel, type WebCapabilities } from "../shared/capabilities";
import { acquirePipeline, type AcquireHandle, type DownloadProgress } from "../shared/modelLoader";
import { readPref, writePref } from "../shared/storage";
import { Badge, DownloadCard, StatusPill } from "../shared/ui";

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
    id: "onnx-community/SmolLM2-135M-Instruct",
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

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function ChatPage() {
  const caps = useCapabilities();
  const recommended = recommendModel(caps);

  const aliveRef = useRef(true);
  const generatorRef = useRef<TextGenerator | null>(null);
  const warmRef = useRef(new Set<string>());
  const userPickedRef = useRef(false);

  const [modelId, setModelId] = useState(MODELS[1].id);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Detecting device…");
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadProgress | null>(null);

  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveTps, setLiveTps] = useState<number | null>(null);
  const [rateVersion, setRateVersion] = useState(0);

  const selected = useMemo(() => MODELS.find((m) => m.id === modelId) ?? MODELS[1], [modelId]);

  // Adopt the recommended model until the user picks one themselves.
  useEffect(() => {
    if (!caps || userPickedRef.current) return;
    setModelId(recommended);
  }, [caps, recommended]);

  useEffect(() => {
    setPrompt(selected.kind === "instruct" ? "Explain photosynthesis in one sentence." : "Once upon a time");
    setOutput("");
    setLiveTps(null);
  }, [selected]);

  /* ----------------------------- model loading ---------------------------- */

  useEffect(() => {
    // Wait for capability detection so we only build the pipeline once, with the
    // right device.
    if (!caps) return;

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
        setStatus("Model ready.");
      } catch (err) {
        if (cancelled) return;
        generatorRef.current = null;
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        setStatus("Failed to load: " + message);
      }
    };

    void run();

    // Cancel in-flight work + dispose the pipeline on navigation/unmount.
    return () => {
      cancelled = true;
      aliveRef.current = false;
      current?.release();
      current = null;
      generatorRef.current = null;
    };
  }, [modelId, caps]);

  /* -------------------------------- generate ------------------------------- */

  const generate = useCallback(async () => {
    const generator = generatorRef.current;
    const text = prompt.trim();
    if (!generator || !text || busy) return;

    setBusy(true);
    setOutput("");
    setLiveTps(null);

    let firstTokenAt = 0;
    let lastTokenAt = 0;
    let tokenCount = 0;
    const isCold = !warmRef.current.has(modelId);

    try {
      const streamer = new TextStreamer(generator.tokenizer as never, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (token: string) => {
          const now = performance.now();
          if (!firstTokenAt) firstTokenAt = now;
          lastTokenAt = now;
          tokenCount++;
          if (!aliveRef.current) return;
          setOutput((prev) => prev + token);
          if (tokenCount >= 2 && lastTokenAt > firstTokenAt) {
            setLiveTps(((tokenCount - 1) * 1000) / (lastTokenAt - firstTokenAt));
          }
        },
      });

      let input = text;
      if (selected.kind === "instruct" && generator.tokenizer.apply_chat_template) {
        input = generator.tokenizer.apply_chat_template([{ role: "user", content: text }], { tokenize: false, add_generation_prompt: true });
      }

      await generator(input, {
        max_new_tokens: 120,
        do_sample: true,
        temperature: 0.7,
        top_p: 0.95,
        repetition_penalty: 1.1,
        streamer,
      });

      if (tokenCount >= 2 && lastTokenAt > firstTokenAt) {
        const tps = ((tokenCount - 1) * 1000) / (lastTokenAt - firstTokenAt);
        writePref<TokenRate>(rateKey(modelId), {
          tps,
          tokens: tokenCount,
          cold: isCold,
          at: Date.now(),
        });
        if (aliveRef.current) setRateVersion((v) => v + 1);
      }
      warmRef.current.add(modelId);
    } catch (err) {
      if (aliveRef.current) {
        setOutput("Error: " + (err instanceof Error ? err.message : String(err)));
      }
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [prompt, busy, modelId, selected]);

  /** Enter submits, except while the user is composing (IME). */
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    const native = event.nativeEvent;
    if (native.isComposing || native.keyCode === 229) return; // IME composition guard
    event.preventDefault();
    void generate();
  };

  const pickModel = (id: string) => {
    userPickedRef.current = true;
    setModelId(id);
  };

  const loadingModel = !ready && !error;

  return (
    <div className="flex w-full flex-1 flex-col items-center">
      <div className="flex w-full max-w-[760px] flex-col px-6 pb-16 pt-10 md:pt-14">
        <header className="mb-8">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="display text-[32px] leading-[0.95] tracking-[-0.03em] md:text-[40px]">Tiny LLM, in your browser.</h1>
            <StatusPill status={error ? "error" : ready ? "ready" : "downloading"}>{error ? "Failed" : ready ? "Ready" : "Loading"}</StatusPill>
          </div>
          <p className="mt-3 max-w-[52ch] text-[14px] leading-6 text-[var(--text-muted)]">
            Runs client-side with Transformers.js. First load downloads the model; afterwards it's cached and works offline. Prompts never leave the tab.
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
            {MODELS.map((model) => {
              const active = model.id === modelId;
              const isRecommended = model.id === recommended;
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
                    <Badge tone={model.kind === "instruct" ? "info" : "warn"}>{model.kind}</Badge>
                    {isRecommended ? <Badge tone="good">recommended</Badge> : null}
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
              modelLabel={modelId}
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

        {/* Prompt bar */}
        <section className="mb-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask something…"
              disabled={!ready || busy}
              className="mono flex-1 rounded-[12px] border border-[var(--border)] bg-[var(--bg-soft)] px-3.5 py-2.5 text-[13px] text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--text)] focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={() => void generate()}
              disabled={!ready || busy || !prompt.trim()}
              className="rounded-[12px] bg-[var(--text)] px-5 py-2.5 text-[13px] font-[500] text-[var(--bg)] transition hover:opacity-[0.9] disabled:cursor-not-allowed disabled:opacity-30"
            >
              {busy ? "Generating…" : "Generate"}
            </button>
          </div>
        </section>

        {/* Status */}
        <p className={`mono mb-4 text-[11px] ${error ? "text-red-600 dark:text-red-400" : "text-[var(--text-faint)]"}`}>{status}</p>

        {/* Output */}
        {output || busy ? (
          <section className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-soft)] p-4">
            <div className="mb-3 flex items-center gap-2">
              <Badge tone="invert">{selected.label}</Badge>
              {busy && liveTps != null ? <span className="mono text-[11px] font-medium text-[var(--text-muted)]">{liveTps.toFixed(1)} tok/s</span> : null}
              {busy && liveTps == null ? <span className="mono text-[11px] text-[var(--text-faint)]">prefill…</span> : null}
            </div>
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text)]">
              {selected.kind === "base" ? <span className="text-[var(--text-faint)]">{prompt}</span> : null}
              {output}
              {busy ? <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-[var(--text)] align-text-bottom" /> : null}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
