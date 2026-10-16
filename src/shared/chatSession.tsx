import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { TextStreamer, InterruptableStoppingCriteria } from "@huggingface/transformers";

import { useCapabilities, recommendModel, type WebCapabilities } from "./capabilities";
import { acquirePipeline, type AcquireHandle, type DownloadProgress } from "./modelLoader";
import { readPref, writePref } from "./storage";
import { BUILTIN_SKILLS, composeSystem, loadSkillsPref, saveSkillsPref, type Skill, type SkillsPref } from "./skills";
import { createConversation, deleteConversationRecord, deriveTitle, loadConversations, saveConversations, DEFAULT_TITLE, type Conversation } from "./conversations";

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

/** Stable empty array so `messages` keeps a consistent identity when no chat exists. */
const EMPTY_MESSAGES: ChatMessage[] = [];

export interface ChatSettings {
  temperature: number;
  topP: number;
  maxNewTokens: number;
  repetitionPenalty: number;
  /** 0 disables the ban; 3 is a good default for small models. */
  noRepeatNgramSize: number;
}

export const DEFAULT_SETTINGS: ChatSettings = {
  // temperature 0 => greedy decoding (`do_sample: false`), the most reliable
  // setting for tiny models; deterministic and less prone to confabulation.
  temperature: 0,
  topP: 0.95,
  maxNewTokens: 128,
  repetitionPenalty: 1.15,
  noRepeatNgramSize: 3,
};

const SETTINGS_KEY = "chat:settings:v1";
const SYSTEM_KEY = "chat:system:v1";

/**
 * Rough token budget for the templated prompt. Oldest turns are dropped once the
 * conversation exceeds this, keeping generation inside small models' context.
 */
export const INPUT_TOKEN_BUDGET = 1536;

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
  /** Messages of the active conversation (empty until one exists). */
  messages: ChatMessage[];
  /** The app-wide base system prompt (edited on the settings page). */
  system: string;
  setSystem: (value: string) => void;
  /** Every conversation, newest first. Backs the sidebar. */
  conversations: Conversation[];
  /** The conversation currently open in the transcript, or `null` while loading. */
  conversation: Conversation | null;
  /** The active conversation's own system prompt (the "System Prompt" bubble). */
  conversationSystem: string;
  setConversationSystem: (value: string) => void;
  /** Create a fresh conversation and select it. */
  newChat: () => void;
  /** Open an existing conversation. */
  selectConversation: (id: string) => void;
  /** Rename a conversation (does not reorder the list). */
  renameConversation: (id: string, title: string) => void;
  /** Delete a conversation; the list always keeps at least one. */
  deleteConversation: (id: string) => void;
  /** Drop every message in the active conversation. */
  clearMessages: () => void;
  /** True once stored conversations have been read back from IndexedDB. */
  hydrated: boolean;
  settings: ChatSettings;
  setSettings: Dispatch<SetStateAction<ChatSettings>>;
  resetSettings: () => void;

  /* ---- prompts & skills ---- */
  /** Built-in + user-authored skills, in display order. */
  skills: Skill[];
  /** Ids of the currently enabled skills. */
  activeSkillIds: string[];
  /** The system prompt actually sent: base system + enabled skill bodies. */
  composedSystem: string;
  /** Toggle a skill on/off. */
  toggleSkill: (id: string) => void;
  /** Add a new custom skill, or update an existing one in place. */
  upsertSkill: (skill: Skill) => void;
  /** Remove a custom skill (built-ins are ignored). */
  removeSkill: (id: string) => void;
  /** Disable all skills and delete all custom ones. */
  resetSkills: () => void;
  /** Count tokens with the live tokenizer, or a ~4-chars-per-token estimate. */
  countTokens: (text: string) => number;

  /* ---- streaming ---- */
  input: string;
  setInput: (value: string) => void;
  streaming: string;
  busy: boolean;
  liveTps: number | null;
  send: () => void;
  stop: () => void;
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
  /** The active conversation id, reachable from stable async callbacks. */
  const activeIdRef = useRef<string | null>(null);

  const [modelId, setModelId] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Pick a model to get started.");
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadProgress | null>(null);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
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
  const [skillsPref, setSkillsPref] = useState<SkillsPref>(() => loadSkillsPref());

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

  // Keep the active conversation id reachable from the stable `send`/`stop` callbacks.
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  /* --------------------------- conversation store -------------------------- */

  // Hydrate from IndexedDB once on mount, seeding a first conversation when
  // there's nothing stored yet. The app-wide base prompt stays in Settings and
  // composes on top of each conversation's own prompt, so we start empty here.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadConversations();
      if (cancelled || !aliveRef.current) return;
      if (stored.length > 0) {
        setConversations(stored);
        setActiveId(stored[0].id);
      } else {
        const first = createConversation();
        setConversations([first]);
        setActiveId(first.id);
      }
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const conversation = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId]);
  const messages = conversation?.messages ?? EMPTY_MESSAGES;
  const conversationSystem = conversation?.system ?? "";

  // If the active id goes stale (deleted, or not chosen yet), fall back to the
  // newest conversation. The list is non-empty once hydrated.
  useEffect(() => {
    if (!hydrated || conversations.length === 0) return;
    if (!activeId || !conversations.some((c) => c.id === activeId)) setActiveId(conversations[0].id);
  }, [hydrated, conversations, activeId]);

  // Debounced write-through: coalesces a burst of edits (typing a system prompt)
  // into a single IndexedDB transaction.
  useEffect(() => {
    if (!hydrated) return;
    const handle = window.setTimeout(() => void saveConversations(conversations), 300);
    return () => window.clearTimeout(handle);
  }, [conversations, hydrated]);

  // Persist system prompt + generation settings.
  useEffect(() => {
    writePref(SYSTEM_KEY, system);
  }, [system]);
  useEffect(() => {
    writePref(SETTINGS_KEY, settings);
  }, [settings]);

  // Skills: built-ins first, then custom ones (persisted separately from settings).
  const skills = useMemo<Skill[]>(() => [...BUILTIN_SKILLS, ...skillsPref.custom], [skillsPref.custom]);
  const activeSkillIds = useMemo(() => skillsPref.enabled.filter((id) => skills.some((s) => s.id === id)), [skillsPref.enabled, skills]);
  const composedSystem = useMemo(
    () =>
      composeSystem(
        system,
        skills.filter((s) => activeSkillIds.includes(s.id)),
        conversationSystem,
      ),
    [system, skills, activeSkillIds, conversationSystem],
  );
  useEffect(() => {
    saveSkillsPref(skillsPref);
  }, [skillsPref]);

  /**
   * Token count for a string, using the live tokenizer when a model is warm and
   * a ~4-chars-per-token estimate otherwise (mirrors `countTokens` above).
   * Stable identity, so it's safe in the memoized context value.
   */
  const measureTokens = useCallback((text: string): number => {
    const tokenizer = generatorRef.current?.tokenizer;
    if (tokenizer && typeof tokenizer.encode === "function") {
      try {
        return tokenizer.encode(text).length;
      } catch {
        /* fall through to the estimate */
      }
    }
    return Math.ceil(text.length / 4);
  }, []);

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
      setStreaming("");
      setInput("");
    },
    [modelId, ready],
  );

  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  /* ------------------------------ conversations ---------------------------- */

  // Patch one conversation by id. A no-op if it was deleted mid-flight.
  const updateConversation = useCallback((id: string, fn: (c: Conversation) => Conversation) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
  }, []);

  const newChat = useCallback(() => {
    if (busyRef.current) return; // don't strand an in-flight generation
    const conv = createConversation();
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    setStreaming("");
    setInput("");
  }, []);

  const selectConversation = useCallback((id: string) => {
    if (busyRef.current) return;
    setActiveId(id);
    setStreaming("");
    setInput("");
  }, []);

  const renameConversation = useCallback(
    (id: string, title: string) => {
      updateConversation(id, (c) => ({ ...c, title: title.trim() || DEFAULT_TITLE }));
    },
    [updateConversation],
  );

  const setConversationSystem = useCallback(
    (value: string) => {
      const id = activeIdRef.current;
      if (id) updateConversation(id, (c) => ({ ...c, system: value }));
    },
    [updateConversation],
  );

  const clearMessages = useCallback(() => {
    const id = activeIdRef.current;
    if (id) updateConversation(id, (c) => ({ ...c, messages: [], updatedAt: Date.now() }));
  }, [updateConversation]);

  const deleteConversation = useCallback((id: string) => {
    if (busyRef.current) return; // don't delete out from under a live generation
    void deleteConversationRecord(id);
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      return next.length > 0 ? next : [createConversation()];
    });
    // If the open chat was removed, drop the selection; the repair effect picks
    // the newest remaining conversation on the next render.
    setActiveId((prev) => (prev === id ? null : prev));
  }, []);

  const stop = useCallback(() => stopperRef.current?.interrupt(), []);

  /* -------------------------------- generate ------------------------------- */

  const send = useCallback(async () => {
    const text = input.trim();
    const convId = activeIdRef.current;
    if (!text || busy || !modelId || !convId) return;

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
    const turns = fitHistory(generator.tokenizer, composedSystem, history, text);
    const isCold = !warmRef.current.has(modelId);

    // Append the user turn immediately (auto-titling on the first one), then
    // stream the reply into a transient buffer until it completes.
    updateConversation(convId, (c) => {
      const nextMessages: ChatMessage[] = [...c.messages, { role: "user", content: text }];
      return {
        ...c,
        messages: nextMessages,
        title: c.title === DEFAULT_TITLE ? deriveTitle(nextMessages) : c.title,
        updatedAt: Date.now(),
      };
    });
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

      const promptText = buildPrompt(generator.tokenizer, composedSystem, turns);

      await generator(promptText, {
        max_new_tokens: settings.maxNewTokens,
        do_sample: settings.temperature > 0,
        temperature: settings.temperature,
        top_p: settings.topP,
        repetition_penalty: settings.repetitionPenalty,
        no_repeat_ngram_size: settings.noRepeatNgramSize,
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
        if (content.trim()) updateConversation(convId, (c) => ({ ...c, messages: [...c.messages, { role: "assistant", content }], updatedAt: Date.now() }));
        setStreaming("");
        setLiveTps(null);
        setBusy(false);
      }
      stopperRef.current = null;
      armIdle();
    }
  }, [input, busy, modelId, messages, composedSystem, settings, ensureLoaded, clearIdle, armIdle, updateConversation]);

  const resetSettings = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  /* ------------------------------- skills --------------------------------- */

  const toggleSkill = useCallback((id: string) => {
    setSkillsPref((prev) => ({
      ...prev,
      enabled: prev.enabled.includes(id) ? prev.enabled.filter((x) => x !== id) : [...prev.enabled, id],
    }));
  }, []);

  const upsertSkill = useCallback((skill: Skill) => {
    setSkillsPref((prev) => {
      const exists = prev.custom.some((s) => s.id === skill.id);
      return {
        ...prev,
        custom: exists ? prev.custom.map((s) => (s.id === skill.id ? skill : s)) : [...prev.custom, skill],
      };
    });
  }, []);

  const removeSkill = useCallback((id: string) => {
    setSkillsPref((prev) => ({
      enabled: prev.enabled.filter((x) => x !== id),
      custom: prev.custom.filter((s) => s.id !== id),
    }));
  }, []);

  const resetSkills = useCallback(() => setSkillsPref({ enabled: [], custom: [] }), []);

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
      conversations,
      conversation,
      conversationSystem,
      setConversationSystem,
      newChat,
      selectConversation,
      renameConversation,
      deleteConversation,
      clearMessages,
      hydrated,
      settings,
      setSettings,
      resetSettings,
      skills,
      activeSkillIds,
      composedSystem,
      toggleSkill,
      upsertSkill,
      removeSkill,
      resetSkills,
      countTokens: measureTokens,
      input,
      setInput,
      streaming,
      busy,
      liveTps,
      send: () => void send(),
      stop,
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
      conversations,
      conversation,
      conversationSystem,
      setConversationSystem,
      newChat,
      selectConversation,
      renameConversation,
      deleteConversation,
      clearMessages,
      hydrated,
      settings,
      resetSettings,
      skills,
      activeSkillIds,
      composedSystem,
      toggleSkill,
      upsertSkill,
      removeSkill,
      resetSkills,
      measureTokens,
      input,
      streaming,
      busy,
      liveTps,
      send,
      stop,
    ],
  );

  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}
