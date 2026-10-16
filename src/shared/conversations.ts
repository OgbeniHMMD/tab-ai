/**
 * Conversations — the multi-chat layer for the `/chat` route.
 *
 * A {@link Conversation} is a self-contained transcript plus its own system
 * prompt. Unlike the app-wide generation settings (temperature, max tokens…),
 * this state is per-chat and durable: the list is persisted to IndexedDB so a
 * reload restores every conversation, not just the last one.
 *
 * We deliberately keep the *model* and *generation settings* global — swapping
 * a loaded pipeline or tuning sampling shouldn't fork per conversation.
 */

import type { ChatMessage } from "./chatSession";

export interface Conversation {
  id: string;
  title: string;
  /** Epoch ms — used for the "updated" ordering + the timestamp in the sidebar. */
  createdAt: number;
  updatedAt: number;
  /** Per-conversation system prompt. Composed on top of the global base prompt. */
  system: string;
  messages: ChatMessage[];
}

export const DEFAULT_TITLE = "New Conversation";

/** Title shown when a conversation has no user turns yet. */
export function newConversationId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createConversation(system = ""): Conversation {
  const now = Date.now();
  return { id: newConversationId(), title: DEFAULT_TITLE, createdAt: now, updatedAt: now, system, messages: [] };
}

/**
 * Derive a short title from the first user turn, mirroring the sidebar in the
 * reference design ("New Conversation" until the user actually says something).
 */
export function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return DEFAULT_TITLE;
  const clean = first.content.replace(/\s+/g, " ").trim();
  if (!clean) return DEFAULT_TITLE;
  return clean.length > 42 ? `${clean.slice(0, 42).trimEnd()}…` : clean;
}

/** `16/10/2026, 10:44:38` — the sidebar/timestamp format from the reference. */
export function formatTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return new Date(ts).toISOString();
  }
}

/** Render a conversation as plain markdown-ish text for export. */
export function conversationToText(conv: Conversation): string {
  const lines: string[] = [`# ${conv.title}`, ""];
  if (conv.system.trim()) lines.push(`> System: ${conv.system.trim()}`, "");
  for (const m of conv.messages) {
    lines.push(`**${m.role === "user" ? "You" : "Assistant"}:**`, m.content, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/* -------------------------------------------------------------------------- */
/*  Persistence (IndexedDB)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Chats live in their own IndexedDB database, deliberately *not* matched by the
 * `transformers|onnx` pattern in `storage.ts`, so "Clear model cache" never
 * wipes a user's conversations.
 */
const DB_NAME = "tabai-chat";
const DB_VERSION = 1;
const STORE = "conversations";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.title === "string" && Array.isArray(v.messages);
}

/** Load every stored conversation, newest first. Empty on any failure. */
export async function loadConversations(): Promise<Conversation[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const rows = (req.result as unknown[]) ?? [];
        resolve(rows.filter(isConversation).sort((a, b) => b.updatedAt - a.updatedAt));
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** Write-through the whole list (small N; the sidebar keeps it in memory anyway). */
export async function saveConversations(convs: Conversation[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const conv of convs) store.put(conv);
  } catch {
    /* quota / private mode — chats just won't survive a reload */
  }
}

export async function deleteConversationRecord(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
  } catch {
    /* ignore */
  }
}
