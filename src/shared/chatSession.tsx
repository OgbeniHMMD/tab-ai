import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { TextStreamer, InterruptableStoppingCriteria } from "@huggingface/transformers";

import { useCapabilities, recommendModel, type WebCapabilities } from "./capabilities";
import { acquirePipeline, type AcquireHandle, type DownloadProgress } from "./modelLoader";
import { readPref, writePref } from "./storage";

/* -------------------------------------------------------------------------- */
/*  Model catalog                                                             */
/* -------------------------------------------------------------------------- */

export interface ChatModel {
  id: string;
  label: string;
  size: string;
  kind: "base" | "instruct";
  note: string;
}

/*
 * `size` is the real `q4` download size, measured from the Hugging Face CDN blob
 * (`content-length`) for each model's `dtype: "q4"` files — not the parameter
 * count, and not the repo's total footprint.
 */
export const MODELS: ChatModel[] = [
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
    size: "~172 MB (q4)",
    kind: "instruct",
    note: "Follows instructions. Good on low-end devices.",
  },
  {
    id: "onnx-community/SmolLM2-360M-Instruct-ONNX",
    label: "SmolLM2 360M",
    size: "~368 MB (q4)",
    kind: "instruct",
    note: "A step up from 135M — still light enough for WASM.",
  },
  {
    id: "onnx-community/Qwen2.5-0.5B-Instruct",
    label: "Qwen2.5 0.5B",
    size: "~749 MB (q4)",
    kind: "instruct",
    note: "Better reasoning. Best with WebGPU.",
  },
  {
    id: "onnx-community/Qwen2.5-1.5B-Instruct",
    label: "Qwen2.5 1.5B",
    size: "~1.7 GB (q4)",
    kind: "instruct",
    note: "Noticeably smarter. Needs WebGPU.",
  },
];

export type TextGenerator = ((input: string, options?: unknown) => Promise<unknown>) & {
  tokenizer: {
    apply_chat_template?: (messages: unknown, options: unknown) => string;
    encode?: (text: string) => number[];
  };
};

export interface TokenRate {
  tps: number;
  tokens: number;
  cold: boolean;
  at: number;
}

export const rateKey = (modelId: string) => `tps:v1:${modelId}`;

/**
 * Persisted "this model has been loaded (and its weights cached) at least once"
 * marker. Used only as a fallback for {@link probeModelCache} — see
 * `src/shared/storage.ts` for why Cache Storage is the authoritative signal.
 */
export const loadedKey = (modelId: string) => `loaded:v1:${modelId}`;

/* -------------------------------------------------------------------------- */
/*  Chat types, defaults & helpers                                            */
/* -------------------------------------------------------------------------- */

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatSettings {
  temperature: number;
  topP: number;
  maxNewTokens: number;
  repetitionPenalty: number;
}

export const DEFAULT_SETTINGS: ChatSettings = {
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
export function buildPrompt(tokenizer: TextGenerator["tokenizer"], system: string, messages: ChatMessage[]): string {
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
/*  Session context                                                           */
/* -------------------------------------------------------------------------- */

export type Phase = "idle" | "loading" | "ready" | "error";

/**
 * How long a fully-loaded pipeline is kept warm with no activity before the
 * provider proactively releases its handle to hand GPU/RAM back to the browser.
 *
 * This is a deliberate, opt-in tradeoff: the model stays built across navigations
 * (the whole point of this provider), but if the tab sits idle we let ORT dispose
 * the session. The next `send()` transparently reloads it — the weights come from
 * Cache Storage, so only the session rebuild (a few seconds) is paid again, not a
 * network download. Set to `0` to disable idling (keep the model loaded forever).
 */
export const IDLE_RELEASE_MS = 5 * 60 * 1000;

export interface ChatSessionValue {
  /** Device capabilities, probed once and shared by every page. */
  caps: WebCapabilities | null;
  /** Recommended model id for the current device. */
  recommended: string;

  /* ---- model lifecycle ---- */
  /** The active model, or `null` until the user picks one. */
  modelId: string | null;
  /** True once the active model's pipeline is built and usable. */
  ready: boolean;
  /** Load failure message, if any. */
  error: string | null;
  /** Human-readable status line for the active model. */
  status: string;
  /** Live download progress while the active model is loading. */
  download: DownloadProgress | null;
  /** Coarse lifecycle phase derived from the fields above. */
  phase: Phase;
  /** Bumped when a generation completes, so rate badges can re-read storage. */
  rateVersion: number;
  /** True once a model has finished loading at least once this session. */
  isLoaded: (id: string) => boolean;
  /** Set the active model, releasing any previous pipeline. Does not navigate. */
  selectModel: (id: string) => void;
  /** Re-run the load for the active model after a failure. */
  retry: () => void;

  /* ---- conversation ---- */
  messages: ChatMessage[];
  system: string;
  setSystem: (value: string) => void;
  settings: ChatSettings;
  setSettings: Dispatch<SetStateAction<ChatSettings>>;
  resetSettings: () => void;

  /* ---- streaming ---- */
  input: string;
  setInput: (value: string) => void;
  streaming: string;
  busy: boolean;
  liveTps: number | null;
  send: () => void;
  stop: () => void;
  newChat: () => void;
}

const ChatSessionContext = createContext<ChatSessionValue | null>(null);

export function useChatSession(): ChatSessionValue {
  const value = useContext(ChatSessionContext);
  if (!value) throw new Error("useChatSession must be used within a <ChatSessionProvider>");
  return value;
}

/* -------------------------------------------------------------------------- */
/*  Provider                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Owns the text-generation pipeline and the active conversation for the whole
 * app, mounted in `Layout` so it wraps every route's `<Outlet />`.
 *
 * LIFECYCLE — the important bit:
 * The provider (not a page) holds the `AcquireHandle`. It is released only when
 * the active model changes, the provider unmounts, or the idle timer fires — so
 * moving between `/models` and `/chat` never tears down the ORT session. Without
 * this, the load effect's cleanup would `disposeEntry()` on route change and the
 * session would be rebuilt from scratch (seconds) on every navigation.
 */
export function ChatSessionProvider({ children }: { children: ReactNode }) {
  const caps = useCapabilities();
  const recommended = recommendModel(caps);

  const aliveRef = useRef(true);
  const capsRef = useRef<WebCapabilities | null>(caps);
  const modelIdRef = useRef<string | null>(null);
  const handleRef = useRef<AcquireHandle<TextGenerator> | null>(null);
  const generatorRef = useRef<TextGenerator | null>(null);
  const loadPromiseRef = useRef<Promise<TextGenerator | null> | null>(null);
  const loadTokenRef = useRef(0);
  const warmRef = useRef(new Set<string>());
  const loadedRef = useRef(new Set<string>());
  const stopperRef = useRef<InterruptableStoppingCriteria | null>(null);
  const busyRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);

  const [modelId, setModelId] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [loading, setLoading] = useState(false);
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

  // Keep the latest values reachable from the (stable) async callbacks.
  useEffect(() => {
    capsRef.current = caps;
  }, [caps]);
  useEffect(() => {
    modelIdRef.current = modelId;
  }, [modelId]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Persist system prompt + generation settings.
  useEffect(() => {
    writePref(SYSTEM_KEY, system);
  }, [system]);
  useEffect(() => {
    writePref(SETTINGS_KEY, settings);
  }, [settings]);

  // Flip the liveness flag + clear the idle timer when the provider goes away.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, []);

  /* ------------------------------ idle handling ---------------------------- */

  const clearIdle = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const releaseIdle = useCallback(() => {
    idleTimerRef.current = null;
    // Never yank the pipeline out from under an in-flight generation.
    if (busyRef.current || !generatorRef.current) return;
    handleRef.current?.release();
    handleRef.current = null;
    generatorRef.current = null;
    setReady(false);
    setStatus("Model unloaded after inactivity to free memory.");
  }, []);

  const armIdle = useCallback(() => {
    clearIdle();
    if (IDLE_RELEASE_MS > 0) idleTimerRef.current = window.setTimeout(releaseIdle, IDLE_RELEASE_MS);
  }, [clearIdle, releaseIdle]);

  /* ------------------------------ model loading ---------------------------- */

  /**
   * Resolve the active model's pipeline, building it on first use. Returns the
   * existing generator if warm, joins an in-flight load if one is running, or
   * starts a new one. Returning `null` means "not available" (no model/caps, or
   * a failed/cancelled load).
   */
  const ensureLoaded = useCallback((): Promise<TextGenerator | null> => {
    if (generatorRef.current) return Promise.resolve(generatorRef.current);
    if (loadPromiseRef.current) return loadPromiseRef.current;

    const activeModel = modelIdRef.current;
    const activeCaps = capsRef.current;
    if (!activeModel || !activeCaps) return Promise.resolve(null);

    const token = ++loadTokenRef.current;
    const cancelled = () => token !== loadTokenRef.current;

    setReady(false);
    setError(null);
    setDownload(null);
    setLoading(true);
    setStatus("Loading model…");

    const onProgress = (progress: DownloadProgress) => {
      if (!cancelled() && aliveRef.current) setDownload(progress);
    };

    // Acquire a handle for one device. On failure the handle is released so the
    // caller can fall back to another device.
    const tryDevice = async (device: "webgpu" | "wasm"): Promise<TextGenerator> => {
      const handle = acquirePipeline<TextGenerator>("text-generation", activeModel, {
        device,
        dtype: "q4",
        onProgress,
      });
      handleRef.current = handle;
      try {
        return await handle.result;
      } catch (err) {
        handle.release();
        if (handleRef.current === handle) handleRef.current = null;
        throw err;
      }
    };

    const promise = (async (): Promise<TextGenerator | null> => {
      try {
        let instance: TextGenerator | null = null;
        if (activeCaps.webgpu) {
          try {
            instance = await tryDevice("webgpu");
          } catch {
            if (cancelled()) return null;
            setStatus("WebGPU unavailable — using WASM…");
            instance = await tryDevice("wasm");
          }
        } else {
          instance = await tryDevice("wasm");
        }

        if (cancelled() || !instance || !aliveRef.current) return null;
        generatorRef.current = instance;
        loadedRef.current.add(activeModel);
        // Record the durable "loaded once" marker as a fallback for the models
        // page's cache probe (see `probeModelCache`). Cache Storage is primary.
        writePref(loadedKey(activeModel), true);
        setReady(true);
        setStatus("Model ready. Say something.");
        armIdle();
        return instance;
      } catch (err) {
        if (cancelled() || !aliveRef.current) return null;
        generatorRef.current = null;
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        setStatus("Failed to load: " + message);
        return null;
      } finally {
        // Only clear the slot if no newer load has taken over.
        if (loadTokenRef.current === token) {
          loadPromiseRef.current = null;
          if (aliveRef.current) setLoading(false);
        }
      }
    })();

    loadPromiseRef.current = promise;
    return promise;
  }, [armIdle]);

  /**
   * Load the active model and keep it warm for the lifetime of the provider.
   * The cleanup is the ONLY place a pipeline is disposed on model change — and,
   * because the provider lives in `Layout`, it does not run on route changes.
   */
  useEffect(() => {
    if (!caps || !modelId) return;
    void ensureLoaded();
    return () => {
      // Cancel any in-flight load for this model and release its handle.
      loadTokenRef.current += 1;
      loadPromiseRef.current = null;
      stopperRef.current?.interrupt();
      handleRef.current?.release();
      handleRef.current = null;
      generatorRef.current = null;
      clearIdle();
    };
  }, [caps, modelId, retryNonce, ensureLoaded, clearIdle]);

  /* -------------------------------- controls ------------------------------- */

  const selectModel = useCallback(
    (id: string) => {
      if (busyRef.current) return; // never swap the pipeline mid-generation
      if (id === modelId) {
        if (ready) return; // already active & warm
        // Not warm (failed earlier, or released by the idle timer) — reload it.
        setRetryNonce((n) => n + 1);
        return;
      }
      setModelId(id);
      setMessages([]);
      setStreaming("");
      setInput("");
    },
    [modelId, ready],
  );

  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  const newChat = useCallback(() => {
    setMessages([]);
    setStreaming("");
    setInput("");
  }, []);

  const stop = useCallback(() => stopperRef.current?.interrupt(), []);

  /* -------------------------------- generate ------------------------------- */

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !modelId) return;

    // Don't let the idle timer fire while we wait on a reload / generation.
    clearIdle();

    let generator = generatorRef.current;
    if (!generator) {
      generator = await ensureLoaded();
      if (!generator) {
        armIdle();
        return;
      }
    }
    if (!aliveRef.current) return;

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
      armIdle();
    }
  }, [input, busy, modelId, messages, system, settings, ensureLoaded, clearIdle, armIdle]);

  const resetSettings = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  const value = useMemo<ChatSessionValue>(
    () => ({
      caps,
      recommended,
      modelId,
      ready,
      error,
      status,
      download,
      phase: error ? "error" : loading ? "loading" : ready ? "ready" : "idle",
      rateVersion,
      isLoaded: (id: string) => loadedRef.current.has(id),
      selectModel,
      retry,
      messages,
      system,
      setSystem,
      settings,
      setSettings,
      resetSettings,
      input,
      setInput,
      streaming,
      busy,
      liveTps,
      send: () => void send(),
      stop,
      newChat,
    }),
    [
      caps,
      recommended,
      modelId,
      loading,
      ready,
      error,
      status,
      download,
      rateVersion,
      selectModel,
      retry,
      messages,
      system,
      settings,
      resetSettings,
      input,
      streaming,
      busy,
      liveTps,
      send,
      stop,
      newChat,
    ],
  );

  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}
