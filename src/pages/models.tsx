import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { MODELS, rateKey, useChatSession, type ChatModel, type TokenRate } from "../shared/chatSession";
import type { WebCapabilities } from "../shared/capabilities";
import { readPref } from "../shared/storage";
import { Badge, DownloadCard, StatusPill, type StatusKind } from "../shared/ui";

/** Only instruct models can actually chat, so only they are offered here. */
const CHAT_MODELS: ChatModel[] = MODELS.filter((m) => m.kind === "instruct");

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

export default function ModelsPage() {
  const navigate = useNavigate();
  const session = useChatSession();
  const { caps, recommended, modelId, ready, error, status, download, phase, rateVersion, busy, selectModel, retry, isLoaded } = session;

  // The card the user is looking at (defaults to the active model, else the
  // device recommendation), plus whether they've confirmed the download.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const selectedId = pickedId ?? modelId ?? recommended;
  const selected = CHAT_MODELS.find((m) => m.id === selectedId) ?? CHAT_MODELS[0];

  const isCurrent = selectedId === modelId;
  const showOpen = isCurrent && ready;
  const showProgress = isCurrent && !ready && phase === "loading";
  const showError = isCurrent && phase === "error";

  const pillStatus: StatusKind = phase === "error" ? "error" : phase === "ready" ? "ready" : phase === "loading" ? "downloading" : "idle";
  const pillLabel = phase === "error" ? "Failed" : phase === "ready" ? "Ready" : phase === "loading" ? "Loading" : "Idle";

  // Once the confirmed model finishes building, move on to the chat surface.
  useEffect(() => {
    if (confirmed && ready && modelId === selectedId) navigate("/chat");
  }, [confirmed, ready, modelId, selectedId, navigate]);

  const pick = (id: string) => {
    setPickedId(id);
    setConfirmed(false);
  };

  const confirm = () => {
    setConfirmed(true);
    selectModel(selectedId);
  };

  return (
    <div className="flex w-full flex-1 flex-col items-center">
      <div className="flex w-full max-w-[760px] flex-col px-6 pb-16 pt-10 md:pt-14">
        <header className="mb-8">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="display text-[32px] leading-[0.95] tracking-[-0.03em] md:text-[40px]">Choose a model.</h1>
            <StatusPill status={pillStatus}>{pillLabel}</StatusPill>
          </div>
          <p className="mt-3 max-w-[52ch] text-[14px] leading-6 text-[var(--text-muted)]">
            Pick a model to load it — first load downloads from Hugging Face, afterwards it's cached and works offline. Everything runs client-side; your prompts never leave the tab.
          </p>
        </header>

        {/* Device capability strip */}
        <section className="mb-6">
          <div className="mono mb-2 text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Your device</div>
          <CapabilityStrip caps={caps} />
        </section>

        {/* Model catalog */}
        <section className="mb-6">
          <div className="mono mb-2 text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Models</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {CHAT_MODELS.map((model) => {
              const active = model.id === selectedId;
              const isRecommended = model.id === recommended;
              const current = model.id === modelId;
              return (
                <button
                  key={model.id}
                  onClick={() => pick(model.id)}
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
                    {current && ready ? <Badge tone="invert">active</Badge> : null}
                    {current && !ready && phase === "loading" ? <Badge tone="warn">loading…</Badge> : null}
                    {current && phase === "error" ? <Badge tone="danger">failed</Badge> : null}
                  </div>
                  <span className="mono mt-2 text-[11px] leading-4 text-[var(--text-muted)]">
                    {model.size} · {model.note}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Confirm / progress / open-chat panel for the selected model */}
        <section className="mb-6">
          {showProgress ? (
            download && download.overall < 100 ? (
              <DownloadCard
                modelLabel={selected.label}
                sizeLabel={selected.size}
                progress={download}
                footer={
                  <span className="mono flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                    Downloading from Hugging Face • cached in your browser
                  </span>
                }
              />
            ) : (
              <div className="flex items-center gap-3 rounded-[16px] border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3.5">
                <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                <span className="mono text-[11px] text-[var(--text-muted)]">{status}</span>
              </div>
            )
          ) : showError ? (
            <div className="rounded-[16px] border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
              <div className="text-[13px] font-[550] text-red-700 dark:text-red-300">Couldn't load {selected.label}</div>
              <p className="mono mt-1.5 break-words text-[11px] leading-5 text-red-600 dark:text-red-400">{error}</p>
              <button
                onClick={retry}
                className="mono mt-3 rounded-full border border-red-300 px-3 py-1 text-[10px] uppercase tracking-widest text-red-700 transition hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
              >
                Try again
              </button>
            </div>
          ) : showOpen ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3.5">
              <span className="text-[13px] text-[var(--text-muted)]">
                <span className="font-[550] text-[var(--text)]">{selected.label}</span> is loaded and ready.
              </span>
              <button
                onClick={() => navigate("/chat")}
                className="rounded-[12px] bg-[var(--text)] px-5 py-2 text-[13px] font-[500] text-[var(--bg)] transition hover:opacity-[0.9]"
              >
                Open chat
              </button>
            </div>
          ) : (
            <div className="rounded-[16px] border border-[var(--border)] bg-[var(--bg-soft)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[14px] font-[550] tracking-[-0.01em]">{selected.label}</div>
                  <p className="mono mt-1 text-[11px] leading-5 text-[var(--text-muted)]">
                    {selected.size} · {selected.note}
                  </p>
                  <p className="mono mt-2 text-[10px] leading-5 text-[var(--text-faint)]">
                    {isLoaded(selected.id)
                      ? "Already cached — only the session is rebuilt."
                      : `Downloads ${selected.size} the first time, then cached in your browser.`}
                  </p>
                </div>
                <button
                  onClick={confirm}
                  disabled={busy}
                  className="shrink-0 rounded-[12px] bg-[var(--text)] px-5 py-2.5 text-[13px] font-[500] text-[var(--bg)] transition hover:opacity-[0.9] disabled:cursor-not-allowed disabled:opacity-30"
                >
                  {isLoaded(selected.id) ? "Load model" : "Download & load"}
                </button>
              </div>
            </div>
          )}
        </section>

        <p className={`mono text-[11px] ${error && isCurrent ? "text-red-600 dark:text-red-400" : "text-[var(--text-faint)]"}`}>{status}</p>
      </div>
    </div>
  );
}
