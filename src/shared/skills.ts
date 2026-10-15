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
 * Because the base system prompt is empty by default, a skill body is often the
 * *only* instruction the model sees, and skills are toggled independently. So
 * each body carries its own short honesty clause, and they are written as short
 * positive directives (small models follow "state X" far more reliably than
 * "do not do Y").
 */
export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "concise",
    name: "Concise",
    description: "Short, direct answers. No preamble.",
    body: `Answer in as few words as needed: no preamble, no restating the question. Ground every claim in the conversation or in facts you are confident about, and say "I don't know" when information is missing instead of guessing.`,
    builtin: true,
  },
  {
    id: "tutor",
    name: "Tutor",
    description: "Explain step by step for a beginner.",
    body: `Teach step by step for a beginner: define each new term the first time you use it, then give one short, concrete example. Explain only what you are confident is correct, and say "I don't know" rather than inventing details.`,
    builtin: true,
  },
  {
    id: "structured",
    name: "Structured",
    description: "Organize answers with headings and bullets.",
    body: `Start with a one-line summary, then short bullet points. Use headings only when the answer has several parts. Keep each point to one fact you are confident about, and flag anything you are unsure of.`,
    builtin: true,
  },
  {
    id: "code",
    name: "Code helper",
    description: "Answer with runnable code first.",
    body: `When asked for code, give one self-contained, runnable snippet first, then a short bullet list of what it does, how to run it, and any caveats. Use only real, documented APIs and standard-library calls; if you are unsure whether a function, flag, or option exists, say so rather than inventing one.`,
    builtin: true,
  },
  {
    id: "socratic",
    name: "Socratic",
    description: "Guide with questions instead of answers.",
    body: `Do not give the answer. Ask one focused question at a time, each grounded in what the user just said, so they can reach it themselves. Keep each question short.`,
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
export const BASELINE_SYSTEM = ``;

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
