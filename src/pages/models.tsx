import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { MODELS, WASM_DTYPE, loadedKey, modelSize, rateKey, useChatSession, type ChatModel, type TokenRate } from "../shared/chatSession";
import type { WebCapabilities } from "../shared/capabilities";
import { probeModelCache, readPref } from "../shared/storage";
import { Badge, DownloadCard, LoadingDialog, StatusPill, useDismissibleLoader, type StatusKind } from "../shared/ui";

/** Only instruct models can actually chat, so only they are offered here. */
const CHAT_MODELS: ChatModel[] = MODELS.filter((m) => m.kind === "instruct");

/* -------------------------------------------------------------------------- */
/*  Cached detection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Reliable "already cached" check, in priority order:
 *  1. loaded in this session (the weights are in memory) — instant, no I/O;
 *  2. a Cache Storage probe (authoritative — see `probeModelCache`);
 *  3. the persisted "loaded once" flag, only when Cache Storage is unavailable.
 */
async function detectCached(model: ChatModel, webgpu: boolean, loadedInSession: boolean): Promise<boolean> {
  if (loadedInSession) return true;
  // Look for the exact dtype files this backend would download. q4 and q4f16
  // are separate blobs, so a previous q4 download can't stand in for q4f16.
  const files = new Set<string>();
  if (webgpu) files.add(`_${model.webgpuDtype}.onnx`);
  if (model.wasmCapable) files.add(`_${WASM_DTYPE}.onnx`);
  if (files.size === 0) return false;
  const probed = await probeModelCache(model.id, [...files]);
  if (probed !== null) return probed;
  return readPref<boolean>(loadedKey(model.id)) === true;
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

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function ModelsPage() {
  const navigate = useNavigate();
  const session = useChatSession();
  const { caps, recommended, modelId, ready, error, status, download, phase, rateVersion, busy, selectModel, retry, isLoaded } = session;

  // The card the user has "armed" with the first click. Only uncached models
  // ever reach this state — a cached model loads on the first click.
  const [armedId, setArmedId] = useState<string | null>(null);
  // The model the user asked to load; once it's ready we continue to /chat.
  const [launchId, setLaunchId] = useState<string | null>(null);
  // Models whose weights are already on disk. Seeded synchronously from the
  // persisted flag, then refined by an async Cache Storage probe.
  const [cachedIds, setCachedIds] = useState<Set<string>>(() => new Set(CHAT_MODELS.filter((m) => readPref<boolean>(loadedKey(m.id))).map((m) => m.id)));

  const isCached = (id: string) => cachedIds.has(id) || isLoaded(id);
  const webgpu = Boolean(caps?.webgpu);

  // Re-probe the caches whenever the active model or its readiness changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const results = await Promise.all(CHAT_MODELS.map(async (m) => [m.id, await detectCached(m, Boolean(caps?.webgpu), isLoaded(m.id))] as const));
      if (!cancelled) setCachedIds(new Set(results.filter(([, cached]) => cached).map(([id]) => id)));
    })();
    return () => {
      cancelled = true;
    };
    // `isLoaded` is a stable-in-practice accessor over a ref; `modelId`/`ready`
    // are the real triggers for a re-probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, ready, rateVersion, caps]);

  const currentModel = CHAT_MODELS.find((m) => m.id === modelId) ?? null;
  const showProgress = Boolean(currentModel) && !ready && phase === "loading";
  const downloading = Boolean(download && download.overall < 100);
  // Weights are on disk (or were cached) — the remaining wait is the session
  // build, which gets the full-screen popup instead of a thin status row.
  const buildingSession = showProgress && !downloading;
  const showError = Boolean(currentModel) && phase === "error";
  const showOpen = Boolean(currentModel) && ready;

  // The session-build popup is dismissible; once dismissed, a compact row keeps
  // the status visible with a way to reopen it.
  const building = useDismissibleLoader(buildingSession);

  const pillStatus: StatusKind = phase === "error" ? "error" : phase === "ready" ? "ready" : phase === "loading" ? "downloading" : "idle";
  const pillLabel = phase === "error" ? "Failed" : phase === "ready" ? "Ready" : phase === "loading" ? "Loading" : "Idle";

  // Once the confirmed model finishes building, move on to the chat surface.
  useEffect(() => {
    if (launchId && ready && modelId === launchId) navigate("/chat");
  }, [launchId, ready, modelId, navigate]);

  /** Second step — actually kick off the load/download. */
  const startLoad = (id: string) => {
    setArmedId(null);
    setLaunchId(id);
    selectModel(id);
  };

  /**
   * First click on a card. Cached models load immediately (no download to
   * confirm); uncached models are only *armed* — the download never starts
   * until the user presses "Download & load".
   */
  const onCardClick = (model: ChatModel) => {
    if (busy) return;
    if (!model.wasmCapable && !webgpu) return; // needs a GPU backend
    if (model.webgpuDtype === "q4f16" && caps != null && !caps.f16) return; // needs shader-f16
    if (model.id === modelId && ready) {
      navigate("/chat");
      return;
    }
    if (isCached(model.id)) {
      startLoad(model.id);
      return;
    }
    setArmedId((prev) => (prev === model.id ? null : model.id));
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
            Pick a model, then confirm to load it — first load downloads from Hugging Face, afterwards it's cached and works offline. Everything runs client-side; your prompts never leave the tab.
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
              const armed = armedId === model.id;
              const isRecommended = model.id === recommended;
              const current = model.id === modelId;
              const cached = isCached(model.id);
              const highlighted = armed || current;
              const needsWebgpu = !model.wasmCapable && !webgpu;
              const needsF16 = model.webgpuDtype === "q4f16" && caps != null && !caps.f16;
              const unavailable = needsWebgpu || needsF16;
              const unavailableReason = needsWebgpu
                ? "This model needs WebGPU, which this browser does not expose."
                : needsF16
                  ? "This model needs WebGPU shader-f16 support, which this device does not provide."
                  : undefined;
              const size = modelSize(model, webgpu);
              return (
                <div
                  key={model.id}
                  className={`flex flex-col rounded-[16px] border p-3.5 transition ${
                    highlighted ? "border-[var(--text)] bg-[var(--surface)] ring-1 ring-[var(--text)]" : "border-[var(--border)] bg-[var(--bg-soft)]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onCardClick(model)}
                    disabled={busy || unavailable}
                    aria-expanded={armed}
                    title={unavailableReason}
                    className={`flex flex-col text-left transition ${busy || unavailable ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="text-[14px] font-[550] tracking-[-0.01em]">{model.label}</span>
                      <TokenRateBadge modelId={model.id} version={rateVersion} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {isRecommended ? <Badge tone="good">recommended</Badge> : null}
                      {unavailable ? <Badge tone="warn">not supported on this device</Badge> : null}
                      {current && ready ? <Badge tone="invert">active</Badge> : null}
                      {current && !ready && phase === "loading" ? <Badge tone="warn">loading…</Badge> : null}
                      {current && phase === "error" ? <Badge tone="danger">failed</Badge> : null}
                      {cached && !unavailable ? <Badge tone="good">cached</Badge> : null}
                    </div>
                    <span className="mono mt-2 text-[11px] leading-4 text-[var(--text-muted)]">
                      {size} · {model.note}
                    </span>
                  </button>

                  {armed ? (
                    <div className="mt-3 border-t border-[var(--border)] pt-3">
                      <p className="mono text-[10px] leading-5 text-[var(--text-faint)]">Downloads {size} the first time, then cached after first time.</p>
                      <button
                        type="button"
                        onClick={() => startLoad(model.id)}
                        disabled={busy}
                        className="mt-2.5 w-full rounded-[10px] bg-[var(--text)] px-4 py-2 text-[12px] font-[500] text-[var(--bg)] transition hover:opacity-[0.9] disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        Download &amp; load
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        {/* Progress / error / open-chat panel for the active model */}
        <section className="mb-6">
          {showProgress ? (
            downloading ? (
              <DownloadCard
                modelLabel={currentModel!.label}
                sizeLabel={modelSize(currentModel!, webgpu)}
                progress={download!}
                footer={
                  <span className="mono flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                    Downloading from Hugging Face • cached in your browser
                  </span>
                }
              />
            ) : !building.open ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3.5">
                <span className="mono text-[11px] text-[var(--text-muted)]">{status}</span>
                <button
                  onClick={building.reopen}
                  className="mono rounded-full border border-[var(--border)] px-3 py-1 text-[10px] uppercase tracking-widest text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                >
                  Show progress
                </button>
              </div>
            ) : null
          ) : showError ? (
            <div className="rounded-[16px] border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
              <div className="text-[13px] font-[550] text-red-700 dark:text-red-300">Couldn't load {currentModel!.label}</div>
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
                <span className="font-[550] text-[var(--text)]">{currentModel!.label}</span> is loaded and ready.
              </span>
              <button onClick={() => navigate("/chat")} className="rounded-[12px] bg-[var(--text)] px-5 py-2 text-[13px] font-[500] text-[var(--bg)] transition hover:opacity-[0.9]">
                Open chat
              </button>
            </div>
          ) : null}
        </section>

        <p className={`mono text-[11px] ${error && currentModel ? "text-red-600 dark:text-red-400" : "text-[var(--text-faint)]"}`}>{status}</p>
      </div>

      {/* Popup for the post-download session build (weights are cached; this is
          the ORT session warming up). The download itself keeps its inline
          DownloadCard above. */}
      <LoadingDialog
        open={building.open}
        status={status}
        progress={null}
        modelLabel={currentModel?.label}
        sizeLabel={currentModel ? modelSize(currentModel, webgpu) : undefined}
        onClose={building.dismiss}
      />
    </div>
  );
}
