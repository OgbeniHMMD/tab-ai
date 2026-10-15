/**
 * A single, shared, cached loader for transformers.js pipelines.
 *
 * Goals:
 *  - Only ever build a given `task + model + device + dtype` pipeline once, and
 *    reuse it across callers (ref-counted).
 *  - Turn transformers.js' per-file download events into one aggregated
 *    `DownloadProgress` snapshot (per-file + overall %).
 *  - Let callers cancel in-flight work (e.g. on navigation) and dispose the
 *    pipeline when the last consumer unmounts.
 */
import { env, pipeline } from "@huggingface/transformers";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface FileDownload {
  file: string;
  loaded: number;
  total: number;
  /** 0..100 */
  progress: number;
  status: "pending" | "downloading" | "done" | "error";
}

export interface DownloadProgress {
  files: FileDownload[];
  /** Aggregate completion across all known files, 0..100. */
  overall: number;
  loadedBytes: number;
  totalBytes: number;
  /** Smoothed throughput in bytes/second, or null until we have a sample. */
  bytesPerSec: number | null;
  /** The file currently being fetched, if any. */
  currentFile: string | null;
}

export type Device = "webgpu" | "wasm" | "cpu";

export interface LoadOptions {
  device?: Device;
  dtype?: string;
  quantized?: boolean;
  /** Called with an aggregated progress snapshot. */
  onProgress?: (progress: DownloadProgress) => void;
}

export interface AcquireHandle<T = any> {
  /** Resolves to the (shared) pipeline instance. */
  result: Promise<T>;
  /**
   * Release this caller's reference. When the last reference is released the
   * pipeline is disposed and evicted from the cache. Safe to call more than once.
   */
  release: () => void;
}

/* -------------------------------------------------------------------------- */
/*  Environment configuration                                                 */
/* -------------------------------------------------------------------------- */

let envConfigured = false;

/**
 * Point onnxruntime-web at the WASM runtime we copy into `public/ort/`
 * (see `vite.config.ts`). Without this, transformers.js falls back to a
 * jsdelivr CDN URL.
 */
function configureEnv(): void {
  if (envConfigured) return;
  envConfigured = true;

  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;

  const base = import.meta.env.BASE_URL || "/";
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = `${base}ort/`;
  }
  // Multithreading relies on SharedArrayBuffer, which needs COOP/COEP. ORT
  // auto-detects availability, so we leave `numThreads` at its default.
}

/* -------------------------------------------------------------------------- */
/*  Registry                                                                  */
/* -------------------------------------------------------------------------- */

interface Entry {
  key: string;
  /** Resolves with the pipeline instance once built. */
  promise: Promise<any>;
  refCount: number;
  /** Set when the last reference was released *before* loading finished. */
  orphaned: boolean;
  loading: boolean;
  instance: any | null;
  error: Error | null;
  listeners: Set<(progress: DownloadProgress) => void>;
  files: Map<string, FileDownload>;
  loadedBytes: number;
  totalBytes: number;
  overall: number;
  currentFile: string | null;
  rate: { lastLoaded: number; lastTime: number; bytesPerSec: number | null };
}

const registry = new Map<string, Entry>();

function progressSnapshot(entry: Entry): DownloadProgress {
  return {
    files: [...entry.files.values()],
    overall: entry.overall,
    loadedBytes: entry.loadedBytes,
    totalBytes: entry.totalBytes,
    bytesPerSec: entry.rate.bytesPerSec,
    currentFile: entry.currentFile,
  };
}

function emit(entry: Entry): void {
  const snapshot = progressSnapshot(entry);
  for (const listener of entry.listeners) listener(snapshot);
}

function keyFor(task: string, modelId: string, options: LoadOptions): string {
  const device = options.device ?? "auto";
  const dtype = options.dtype ?? "auto";
  const quantized = options.quantized ?? false;
  return `${task}::${modelId}::${device}::${dtype}::${quantized}`;
}

/* -------------------------------------------------------------------------- */
/*  Progress bookkeeping                                                      */
/* -------------------------------------------------------------------------- */

interface RawProgressEvent {
  status?: string;
  name?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

const RATE_WINDOW_MS = 400;

function handleProgressEvent(entry: Entry, event: RawProgressEvent): void {
  const file = event.file || event.name || "model";
  let record = entry.files.get(file);

  const status = event.status ?? "progress";

  if (status === "initiate") {
    if (!record) {
      record = { file, loaded: 0, total: 0, progress: 0, status: "pending" };
      entry.files.set(file, record);
    }
  } else if (status === "download" || status === "progress") {
    const loaded = typeof event.loaded === "number" ? event.loaded : (record?.loaded ?? 0);
    const total = typeof event.total === "number" ? event.total : (record?.total ?? 0);
    const progress = typeof event.progress === "number" ? event.progress : total > 0 ? (loaded / total) * 100 : (record?.progress ?? 0);

    record = {
      file,
      loaded,
      total,
      progress: Math.min(100, Math.max(0, progress)),
      status: "downloading",
    };
    entry.files.set(file, record);
    entry.currentFile = file;
  } else if (status === "done") {
    if (record) {
      record = { ...record, progress: 100, status: "done" };
    } else {
      record = { file, loaded: 0, total: 0, progress: 100, status: "done" };
    }
    entry.files.set(file, record);
  }

  // Recompute aggregate + throughput.
  const withTotals = [...entry.files.values()].filter((f) => f.total > 0);
  if (withTotals.length > 0) {
    const loaded = withTotals.reduce((sum, f) => sum + f.loaded, 0);
    const total = withTotals.reduce((sum, f) => sum + f.total, 0);
    entry.loadedBytes = loaded;
    entry.totalBytes = total;
    entry.overall = total > 0 ? (loaded / total) * 100 : 0;
  } else if (entry.files.size > 0) {
    const all = [...entry.files.values()];
    entry.overall = all.reduce((sum, f) => sum + f.progress, 0) / all.length;
  }

  const now = Date.now();
  const seconds = (now - entry.rate.lastTime) / 1000;
  const delta = entry.loadedBytes - entry.rate.lastLoaded;
  if (seconds > RATE_WINDOW_MS / 1000 && delta > 0) {
    entry.rate = { lastLoaded: entry.loadedBytes, lastTime: now, bytesPerSec: delta / seconds };
  }

  emit(entry);
}

/* -------------------------------------------------------------------------- */
/*  Acquire / release                                                         */
/* -------------------------------------------------------------------------- */

function createEntry(task: string, modelId: string, options: LoadOptions, key: string): Entry {
  const entry: Entry = {
    key,
    promise: Promise.resolve(null),
    refCount: 0,
    orphaned: false,
    loading: true,
    instance: null,
    error: null,
    listeners: new Set(),
    files: new Map(),
    loadedBytes: 0,
    totalBytes: 0,
    overall: 0,
    currentFile: null,
    rate: { lastLoaded: 0, lastTime: Date.now(), bytesPerSec: null },
  };

  configureEnv();

  const pipelineOptions: Record<string, unknown> = {
    progress_callback: (event: RawProgressEvent) => {
      if (entry.orphaned) return;
      handleProgressEvent(entry, event);
    },
  };
  if (options.device) pipelineOptions.device = options.device;
  if (options.dtype) pipelineOptions.dtype = options.dtype;
  if (options.quantized !== undefined) pipelineOptions.quantized = options.quantized;

  entry.promise = (pipeline(task as any, modelId, pipelineOptions as any) as unknown as Promise<any>)
    .then((instance: any) => {
      entry.loading = false;
      entry.instance = instance;
      entry.overall = 100;
      emit(entry);
      if (entry.orphaned || entry.refCount <= 0) {
        // Nobody is waiting for this anymore.
        void disposeEntry(entry);
      }
      return instance;
    })
    .catch((err: unknown) => {
      entry.loading = false;
      entry.error = err instanceof Error ? err : new Error(String(err));
      for (const record of entry.files.values()) {
        if (record.status !== "done") record.status = "error";
      }
      emit(entry);
      registry.delete(entry.key);
      throw entry.error;
    });

  return entry;
}

async function disposeEntry(entry: Entry): Promise<void> {
  registry.delete(entry.key);
  entry.listeners.clear();
  entry.files.clear();
  const instance = entry.instance;
  entry.instance = null;
  if (instance && typeof instance.dispose === "function") {
    try {
      await instance.dispose();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Acquire a (shared) pipeline for `task`/`modelId`. The pipeline is built once
 * and re-used by every caller with the same key. Call `release()` from your
 * effect cleanup to cancel in-flight work and dispose when it's the last handle.
 */
export function acquirePipeline<T = any>(task: string, modelId: string, options: LoadOptions = {}): AcquireHandle<T> {
  const key = keyFor(task, modelId, options);

  let entry = registry.get(key);
  if (!entry) {
    entry = createEntry(task, modelId, options, key);
    registry.set(key, entry);
  }
  entry.refCount += 1;
  entry.orphaned = false;

  const currentEntry = entry;
  if (options.onProgress) {
    currentEntry.listeners.add(options.onProgress);
    // Immediately replay current state so late subscribers aren't blank.
    options.onProgress(progressSnapshot(currentEntry));
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (options.onProgress) currentEntry.listeners.delete(options.onProgress);
    currentEntry.refCount = Math.max(0, currentEntry.refCount - 1);
    if (currentEntry.refCount === 0) {
      if (currentEntry.loading) {
        currentEntry.orphaned = true;
      } else {
        void disposeEntry(currentEntry);
      }
    }
  };

  return { result: currentEntry.promise as Promise<T>, release };
}

/**
 * Eagerly dispose every cached pipeline. Used before clearing caches so ORT
 * releases its WASM/heap references.
 */
export async function disposeAllPipelines(): Promise<void> {
  const entries = [...registry.values()];
  await Promise.all(entries.map((entry) => disposeEntry(entry)));
}

/** Dispose only the pipelines backed by a given model id. */
export async function disposePipelinesForModel(modelId: string): Promise<void> {
  const entries = [...registry.values()].filter((entry) => entry.key.includes(`::${modelId}::`));
  await Promise.all(entries.map((entry) => disposeEntry(entry)));
}

/* -------------------------------------------------------------------------- */
/*  Formatting helper (shared by the download UI)                             */
/* -------------------------------------------------------------------------- */

export function formatBytes(bytes: number): string {
  if (!bytes || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
