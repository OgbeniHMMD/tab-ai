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
 *
 * Skills are toggled independently and the base prompt defaults to empty, so
 * each body assumes {@link BASELINE_SYSTEM} has already supplied the universal
 * honesty fallback and focuses only on its task. They are written as short
 * positive directives (small models follow "state X" far more reliably than
 * "do not do Y").
 */
export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "concise",
    name: "Concise",
    description: "Short, direct answers. No preamble.",
    body: `Use as few words as possible. Start with the answer.`,
    builtin: true,
  },
  {
    id: "tutor",
    name: "Tutor",
    description: "Explain step by step for a beginner.",
    body: `Teach a beginner. Define each new term the first time you use it. Then give one short example.`,
    builtin: true,
  },
  {
    id: "structured",
    name: "Structured",
    description: "Organize answers with headings and bullets.",
    body: `Start with one summary line. Then use short bullet points. Put one fact in each point.`,
    builtin: true,
  },
  {
    id: "code",
    name: "Code helper",
    description: "Answer with runnable code first.",
    body: `Give one small, complete code sample first. Then list how to run it.`,
    builtin: true,
  },
  {
    id: "socratic",
    name: "Socratic",
    description: "Guide with questions instead of answers.",
    body: `Do not give the answer. Ask one short question at a time. Base each question on what the user just said.`,
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
  return typeof v.id === "string" && typeof v.name === "string" && typeof v.description === "string" && typeof v.body === "string";
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
 * A universal honesty baseline that {@link composeSystem} always folds in, no
 * matter what the base prompt is or which skills are on. Skills are toggled
 * independently and the base prompt defaults to empty, so without this a user
 * could end up giving the model no instructions at all. Front-loaded (it comes
 * before the base prompt) because small models weight the start of the system
 * message most. Kept short: it shares the 1536-token input budget with chat.
 */
export const BASELINE_SYSTEM = `If you are not sure, say "I don't know".`;

/**
 * Compose the final system prompt: the baseline honesty instruction, then the
 * user's base prompt, then the active skills in the order given. Empty pieces
 * are dropped so we never emit stray blank sections.
 */
export function composeSystem(base: string, active: Skill[]): string {
  const trimmedBase = base.trim();
  const blocks = active.map((s) => s.body.trim()).filter(Boolean);
  return [BASELINE_SYSTEM, trimmedBase, ...blocks].filter(Boolean).join("\n\n");
}
