import { useState } from "react";

import { INPUT_TOKEN_BUDGET, useChatSession } from "../shared/chatSession";
import { newSkillId, type Skill } from "../shared/skills";
import { Badge, Slider } from "../shared/ui";

/* -------------------------------------------------------------------------- */
/*  Small pieces                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Live "system + skills vs input budget" meter. When the prompt grows past the
 * budget, `fitHistory` starts dropping conversation turns, so we flag it here
 * rather than letting the user discover the memory loss mid-chat.
 */
function TokenMeter({ used, budget }: { used: number; budget: number }) {
  const ratio = budget > 0 ? used / budget : 0;
  const tone = ratio > 1 ? "danger" : ratio > 0.5 ? "warn" : "neutral";
  const barClass = tone === "danger" ? "bg-red-500" : tone === "warn" ? "bg-amber-500" : "bg-[var(--text)]";

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="mono text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Prompt budget</span>
        <span className="mono text-[11px] text-[var(--text-muted)]">
          ~{used} / {budget} tokens
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
        <div className={`h-full rounded-full transition-all ${barClass}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      {tone === "danger" ? (
        <p className="mono mt-1.5 text-[10px] leading-4 text-red-600 dark:text-red-400">System + skills exceed the budget — oldest chat turns will be dropped to fit.</p>
      ) : tone === "warn" ? (
        <p className="mono mt-1.5 text-[10px] leading-4 text-amber-600 dark:text-amber-400">Using more than half the budget on instructions leaves less room for chat history.</p>
      ) : (
        <p className="mono mt-1.5 text-[10px] leading-4 text-[var(--text-faint)]">Counted with the active model's tokenizer once it's loaded.</p>
      )}
    </div>
  );
}

function SkillRow({ skill, active, onToggle, onEdit, onDelete }: { skill: Skill; active: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-[12px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-[550] tracking-[-0.01em]">{skill.name}</span>
          {skill.builtin ? <Badge>built-in</Badge> : <Badge tone="info">custom</Badge>}
        </div>
        <p className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">{skill.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {skill.builtin ? null : (
          <>
            <button
              type="button"
              onClick={onEdit}
              className="mono rounded-full border border-[var(--border)] px-3 py-1 text-[10px] uppercase tracking-widest text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="mono rounded-full border border-[var(--border)] px-3 py-1 text-[10px] uppercase tracking-widest text-[var(--text-faint)] transition hover:border-red-300 hover:text-red-600 dark:hover:text-red-400"
            >
              Delete
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={active}
          className={`mono rounded-full px-3 py-1 text-[10px] uppercase tracking-widest transition ${
            active
              ? "border border-transparent bg-[var(--text)] text-[var(--bg)]"
              : "border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
          }`}
        >
          {active ? "On" : "Off"}
        </button>
      </div>
    </div>
  );
}

function SkillEditor({ initial, onSave, onCancel }: { initial: Skill | null; onSave: (skill: Skill) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");

  const inputClass =
    "mono w-full rounded-[12px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[12px] leading-5 text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--text)] focus:outline-none";

  const canSave = name.trim().length > 0 && body.trim().length > 0;

  return (
    <div className="space-y-3 rounded-[16px] border border-[var(--border-strong)] bg-[var(--bg-soft)] p-4">
      <div className="mono text-[10px] uppercase tracking-widest text-[var(--text-faint)]">{initial ? "Edit skill" : "New skill"}</div>
      <label className="block">
        <span className="mono mb-1.5 block text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pirate" className={inputClass} />
      </label>
      <label className="block">
        <span className="mono mb-1.5 block text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Description</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line shown in the skill list" className={inputClass} />
      </label>
      <label className="block">
        <span className="mono mb-1.5 block text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Instructions</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Injected into the system prompt when this skill is on." className={`${inputClass} resize-y`} />
      </label>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="mono rounded-full border border-[var(--border)] px-3 py-1 text-[10px] uppercase tracking-widest text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSave}
          onClick={() =>
            onSave({
              id: initial?.id ?? newSkillId(),
              name: name.trim(),
              description: description.trim(),
              body: body.trim(),
            })
          }
          className="rounded-[10px] bg-[var(--text)] px-4 py-1.5 text-[12px] font-[500] text-[var(--bg)] transition hover:opacity-[0.9] disabled:cursor-not-allowed disabled:opacity-30"
        >
          Save skill
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Panel                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The settings body, rendered in the in-chat drawer. It deliberately contains no
 * page chrome or navigation links, so it can be embedded anywhere without
 * routing the user away.
 */
export function SettingsPanel() {
  const { system, setSystem, skills, activeSkillIds, composedSystem, toggleSkill, upsertSkill, removeSkill, resetSkills, countTokens, settings, setSettings, resetSettings } = useChatSession();

  // `null` = editor closed; a Skill = editing that one; "new" sentinel = creating.
  const [editing, setEditing] = useState<Skill | null | "new">(null);

  const customSkills = skills.filter((s) => !s.builtin);
  const systemTokens = countTokens(composedSystem);

  const saveSkill = (skill: Skill) => {
    upsertSkill(skill);
    setEditing(null);
  };

  return (
    <div className="space-y-6">
      {/* System prompt */}
      <section>
        <div className="mono mb-2 text-[10px] uppercase tracking-widest text-[var(--text-faint)]">System prompt</div>
        <div className="rounded-[16px] border border-[var(--border)] bg-[var(--bg-soft)] p-4">
          <textarea
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            rows={4}
            placeholder="Optional base instruction — sets the assistant's role, tone, or rules. Small models follow this loosely."
            className="mono w-full resize-y rounded-[12px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[12px] leading-5 text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--text)] focus:outline-none"
          />
          <div className="mt-4">
            <TokenMeter used={systemTokens} budget={INPUT_TOKEN_BUDGET} />
          </div>
        </div>
      </section>

      {/* Skills */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <span className="mono text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Skills</span>
          <span className="flex items-center gap-3">
            <span className="mono text-[10px] text-[var(--text-faint)]">
              {activeSkillIds.length} of {skills.length} on
            </span>
            <button
              type="button"
              onClick={resetSkills}
              disabled={activeSkillIds.length === 0 && customSkills.length === 0}
              className="mono text-[10px] uppercase tracking-widest text-[var(--text-faint)] transition hover:text-[var(--text)] disabled:opacity-40"
            >
              Reset
            </button>
          </span>
        </div>

        <div className="space-y-2">
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              active={activeSkillIds.includes(skill.id)}
              onToggle={() => toggleSkill(skill.id)}
              onEdit={() => setEditing(skill)}
              onDelete={() => removeSkill(skill.id)}
            />
          ))}
        </div>

        <div className="mt-3">
          {editing === "new" ? (
            <SkillEditor initial={null} onSave={saveSkill} onCancel={() => setEditing(null)} />
          ) : editing ? (
            <SkillEditor initial={editing} onSave={saveSkill} onCancel={() => setEditing(null)} />
          ) : (
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="mono w-full rounded-[12px] border border-dashed border-[var(--border-strong)] px-4 py-2.5 text-[11px] tracking-wide text-[var(--text-muted)] transition hover:border-[var(--text)] hover:text-[var(--text)]"
            >
              + New skill
            </button>
          )}
        </div>
      </section>

      {/* Effective prompt preview */}
      <section>
        <details className="group rounded-[16px] border border-[var(--border)] bg-[var(--bg-soft)]">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3">
            <span className="mono text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Preview effective prompt</span>
            <span className="text-[var(--text-faint)] transition group-open:rotate-180">▾</span>
          </summary>
          <div className="border-t border-[var(--border)] px-4 py-3">
            <pre className="mono max-h-64 overflow-y-auto whitespace-pre-wrap text-[11px] leading-5 text-[var(--text-muted)]">{composedSystem}</pre>
            <p className="mono mt-3 text-[10px] leading-4 text-[var(--text-faint)]">
              A baseline honesty instruction is always prepended — it can't be turned off by editing the system prompt or disabling skills.
            </p>
          </div>
        </details>
      </section>

      {/* Generation */}
      <section>
        <div className="mono mb-2 text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Generation</div>
        <div className="rounded-[16px] border border-[var(--border)] bg-[var(--bg-soft)] p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Slider
              label="Temperature"
              value={settings.temperature}
              min={0}
              max={1.5}
              step={0.05}
              format={(v) => v.toFixed(2)}
              hint="0 = greedy decoding: always pick the most likely token, so replies are deterministic and less likely to wander. Above 0 adds randomness (varied but less reliable); it also turns sampling on."
              onChange={(v) => setSettings((s) => ({ ...s, temperature: v }))}
            />
            <Slider
              label="Top-p"
              value={settings.topP}
              min={0.1}
              max={1}
              step={0.05}
              format={(v) => v.toFixed(2)}
              hint="Nucleus sampling cutoff. Note: the current runtime version does not apply top-p, so changing it has no effect yet."
              onChange={(v) => setSettings((s) => ({ ...s, topP: v }))}
            />
            <Slider
              label="Max new tokens"
              value={settings.maxNewTokens}
              min={64}
              max={1024}
              step={32}
              hint="Upper bound on how many tokens the reply may generate. 128 is about a short paragraph; code or step-by-step answers can be cut off if set too low."
              onChange={(v) => setSettings((s) => ({ ...s, maxNewTokens: v }))}
            />
            <Slider
              label="Repetition penalty"
              value={settings.repetitionPenalty}
              min={1}
              max={1.5}
              step={0.05}
              format={(v) => v.toFixed(2)}
              hint="Above 1.0 discourages the model from reusing tokens it already produced or read. 1.15 is mild; past ~1.3 small models start to sound incoherent."
              onChange={(v) => setSettings((s) => ({ ...s, repetitionPenalty: v }))}
            />
            <Slider
              label="No-repeat n-gram"
              value={settings.noRepeatNgramSize}
              min={0}
              max={6}
              step={1}
              hint="Bans the model from reusing any run of this many tokens, which kills the loops small models fall into. 3 is a good default; 0 turns the ban off; raise to 4 if answers feel forced around your question's wording."
              onChange={(v) => setSettings((s) => ({ ...s, noRepeatNgramSize: v }))}
            />
          </div>
          <p className="mono mt-4 text-[10px] leading-4 text-[var(--text-faint)]">
            Defaults are tuned for the small on-device models: greedy decoding (temperature 0), a tight output cap, and a repetition penalty plus no-repeat n-gram to stop loops.
          </p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="mono text-[10px] text-[var(--text-faint)]">Non-zero temperature enables sampling.</span>
            <button
              onClick={resetSettings}
              className="mono rounded-full border border-[var(--border)] px-3 py-1 text-[10px] tracking-wide text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            >
              Reset defaults
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
