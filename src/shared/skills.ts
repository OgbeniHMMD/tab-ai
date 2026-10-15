import { readPref, writePref } from "./storage";

/* -------------------------------------------------------------------------- */
/*  Skills                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A "skill" is a named, toggleable block of instruction text that gets composed
 * into the single system prompt at request time (see {@link composeSystem}).
 *
 * Built-in skills ship with the app (like the `MODELS` catalog) and are never
 * deleted; user-authored skills live only in `localStorage` under
 * {@link USER_SKILLS_KEY} and can be edited/removed.
 */
export interface Skill {
  id: string;
  name: string;
  description: string;
  /** The instruction text injected into the system prompt. */
  body: string;
  /** Shipped in code — not editable or deletable by the user. */
  builtin?: boolean;
}

/** The persisted user side of skills: which are on, plus any custom ones. */
export interface SkillsPref {
  enabled: string[];
  custom: Skill[];
}

export const USER_SKILLS_KEY = "chat:skills:v1";

export const DEFAULT_SKILLS_PREF: SkillsPref = { enabled: [], custom: [] };

/**
 * Built-in skills. Deliberately terse: these share the same 1536-token input
 * budget as the conversation (see `INPUT_TOKEN_BUDGET`), so every line here
 * costs context that would otherwise be chat memory.
 */
export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "concise",
    name: "Concise",
    description: "Short, direct answers. No preamble.",
    body: "Answer in as few words as possible. Skip preamble, disclaimers, and restating the question.",
    builtin: true,
  },
  {
    id: "tutor",
    name: "Tutor",
    description: "Explain step by step for a beginner.",
    body: "Explain step by step for a beginner. Define jargon the first time you use it and give one short example.",
    builtin: true,
  },
  {
    id: "structured",
    name: "Structured",
    description: "Organize answers with headings and bullets.",
    body: "Structure every answer: a one-line summary first, then short bullet points. Use headings only when the answer has more than one part.",
    builtin: true,
  },
  {
    id: "code",
    name: "Code helper",
    description: "Answer with runnable code first.",
    body: "When asked for code, reply with a single runnable snippet first, then a short bullet list of what it does and any caveats.",
    builtin: true,
  },
  {
    id: "socratic",
    name: "Socratic",
    description: "Guide with questions instead of answers.",
    body: "Do not give the answer outright. Ask one focused question at a time to help the user reach it themselves.",
    builtin: true,
  },
];

/** Prefix for user-created skill ids, so they never collide with built-ins. */
const CUSTOM_ID_PREFIX = "custom-";

/** Mint a unique id for a user-authored skill. */
export function newSkillId(): string {
  return `${CUSTOM_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function isSkill(value: unknown): value is Skill {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.description === "string" &&
    typeof v.body === "string"
  );
}

/** Read the persisted skills preference, tolerating missing/corrupt data. */
export function loadSkillsPref(): SkillsPref {
  const raw = readPref<Partial<SkillsPref>>(USER_SKILLS_KEY);
  if (!raw) return { ...DEFAULT_SKILLS_PREF };
  return {
    enabled: Array.isArray(raw.enabled) ? raw.enabled.filter((id): id is string => typeof id === "string") : [],
    custom: Array.isArray(raw.custom) ? raw.custom.filter(isSkill) : [],
  };
}

export function saveSkillsPref(pref: SkillsPref): void {
  writePref(USER_SKILLS_KEY, pref);
}

/**
 * Compose the final system prompt from the base prompt plus the active skills.
 * Order is preserved (base first, then skills in the order given), and empty
 * pieces are dropped so we never emit stray blank sections.
 */
export function composeSystem(base: string, active: Skill[]): string {
  const trimmedBase = base.trim();
  const blocks = active.map((s) => s.body.trim()).filter(Boolean);
  return [trimmedBase, ...blocks].filter(Boolean).join("\n\n");
}
