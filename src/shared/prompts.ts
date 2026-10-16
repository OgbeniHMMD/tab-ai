/**
 * Composer affordances: the `/` prompt library and the `;` command palette.
 *
 * These are intentionally plain data — the composer filters them as the user
 * types, so adding a prompt or command is a one-line change with no UI work.
 */

export interface PromptTemplate {
  id: string;
  label: string;
  description: string;
  /** Inserted verbatim into the composer when the prompt is picked. */
  text: string;
}

/**
 * User-message templates surfaced by `/`. They are *message* starters (unlike
 * skills, which are system-level instructions toggled in Settings), so picking
 * one fills the composer for the user to finish.
 */
export const PROMPTS: PromptTemplate[] = [
  {
    id: "summarize",
    label: "Summarize",
    description: "Condense text into a short summary",
    text: "Summarize the following text in a few sentences:\n\n",
  },
  {
    id: "explain",
    label: "Explain simply",
    description: "Explain something for a beginner",
    text: "Explain the following in simple terms, as if to a beginner:\n\n",
  },
  {
    id: "translate",
    label: "Translate",
    description: "Translate text into another language",
    text: "Translate the following text into English:\n\n",
  },
  {
    id: "proofread",
    label: "Proofread",
    description: "Fix grammar and spelling",
    text: "Proofread the following text and return the corrected version:\n\n",
  },
  {
    id: "brainstorm",
    label: "Brainstorm",
    description: "Generate a list of ideas",
    text: "Give me 5 ideas for: ",
  },
  {
    id: "steps",
    label: "Step by step",
    description: "Break a task into ordered steps",
    text: "Break the following task into clear, ordered steps:\n\n",
  },
];

export interface Command {
  name: string;
  description: string;
}

/** Actions surfaced by `;`. Execution is wired in the chat page. */
export const COMMANDS: Command[] = [
  { name: "new", description: "Start a new conversation" },
  { name: "clear", description: "Clear messages in this conversation" },
  { name: "rename", description: "Rename this conversation" },
  { name: "system", description: "Edit this conversation's system prompt" },
  { name: "models", description: "Open the model catalog" },
  { name: "settings", description: "Open settings" },
  { name: "stop", description: "Stop the current response" },
];
