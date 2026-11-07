-- Migration 198: Work proposals → triage + standup verdict recipes (Loops v3
-- Phases 1-2; docs/loop-engine/WORK-PROPOSALS-DESIGN.md, "Proposer contract").
--
-- The verdict tool (verdict-tool.ts) already carries a fourth needs_user kind,
-- 'work_proposal', and the apply engine (verdict-apply.ts) cards + server-clamps
-- it. This migration teaches the two SYSTEM verdict recipes WHEN to reach for it:
--   * Proposal Triage  (slug 'triage')        — migration 166 flipped it to verdict.
--   * Standup Sync      (slug 'standup-sync')  — migration 194 flipped it to verdict.
--
-- Both migrations SET the whole system_prompt / agent_config. To avoid re-embedding
-- (and drifting from) those long prompts, this migration is strictly APPEND-ONLY:
--   * system_prompt — concatenate a "## When to propose WORK vs a card" section,
--     guarded by position() so a re-run never double-appends (idempotent).
--   * agent_config.context_rules — append ONE rule via jsonb `||`, guarded by a
--     NOT-EXISTS check on the marker prefix so a re-run is a no-op.
--
-- The guidance: emit needs_user kind 'work_proposal' when the item is work an
-- AGENT could do with workspace tools (draft an email, prepare a doc, research +
-- summarize) instead of a bare action card. Its payload.task must be SELF-
-- CONTAINED (what to do, the names/quotes/context, the desired output); payload.
-- resources should NAME the capture / contacts / entities it drew on; and email-
-- drafting work must include email_to_name / email_to_address when known.
--
-- Idempotent: UPDATE by natural key (is_system + slug), matching the single system
-- row on every environment (migration 159/192 keyed the same way). The position()
-- and jsonb guards make a re-run a safe no-op even though the concatenation itself
-- is not naturally idempotent.
--
-- ARM-TIME / FORK TRAP (carried from migrations 166 and 194): this flips the SYSTEM
-- rows ONLY (is_system=true). Any WORKSPACE COPY of triage or standup-sync (same
-- slug, is_system=false, created by a fork) does NOT inherit this append and keeps
-- its old prose — acceptable; forks keep their old behavior. A loop pointing at a
-- forked copy will not propose work until that copy is re-pointed at the system row
-- or itself updated. Verify a loop's run_skill skill_id resolves to the SYSTEM
-- recipe before expecting work proposals from it.
--
-- Trust: unchanged. work_proposal cards NEVER auto-apply (they are definitionally
-- the "needs a human yes" class) — no trust config is touched here, and the apply
-- engine cards every work_proposal regardless of mode/trust.

-- ── The shared guidance block (prose) ────────────────────────────────────────
-- A leading marker line ('## When to propose WORK') doubles as the idempotency
-- sentinel: if it's already in the prompt, we skip the append.

update recipe set
  system_prompt = system_prompt || $wp$

## When to propose WORK vs a card

Some needs_user items are not "you need to do X" — they are work an AGENT could do for the user with workspace tools: draft a follow-up email, prepare a short doc, research a topic and summarize it, reconcile notes into a board update. For those, emit a needs_user item with `kind: "work_proposal"` INSTEAD OF a bare `action_card`. Reserve `action_card` for work only the human can do (a decision to make, a person only they can talk to, an approval only they can give).

A work_proposal's `payload` must make the task runnable by an agent that has NONE of your context:

- `task` (REQUIRED) — self-contained instructions: WHAT to do, the relevant names / quotes / context inline, and the DESIRED OUTPUT. "Draft a follow-up email to Randy about the GA access he asked for on the call, referencing the Q3 timeline he mentioned" — not "follow up with Randy". If you cannot write a self-contained task, it is not a work_proposal; make it a question or action_card.
- `resources` (optional) — name the capture / contacts / entities the work draws on: `[{ "type": "capture", "id": "…", "label": "Today's sync" }, { "type": "contact", "label": "Randy Chen" }]`. `id` is optional (a label-only ref is fine).
- `deliverable_hint` (optional) — one of `email_draft` | `document` | `board_update` | `mixed`.
- For EMAIL-drafting work, include `email_to_name` and `email_to_address` when you know them (the agent drafts, never sends).

Keep the same restraint as everywhere else: propose work only when it is genuinely worth doing and the agent could actually complete it. A work_proposal is never auto-applied — it always becomes a card the user starts with one click.$wp$,
  updated_at = now()
where is_system = true
  and slug in ('triage', 'standup-sync')
  and position('## When to propose WORK' in system_prompt) = 0;

-- ── The matching context_rule (agent_config.context_rules) ───────────────────
-- Append one rule, guarded so a re-run (or a row that already carries it) no-ops.
-- The marker prefix 'work_proposal:' makes the guard cheap and stable.

update recipe set
  agent_config = jsonb_set(
    agent_config,
    '{context_rules}',
    coalesce(agent_config -> 'context_rules', '[]'::jsonb) ||
      jsonb_build_array(
        'work_proposal: when a needs_user item is work an AGENT could do with workspace tools (draft an email, prepare a doc, research + summarize), emit kind "work_proposal" with a SELF-CONTAINED payload.task (what to do, the relevant names/quotes/context, the desired output) plus optional resources naming the capture/contacts/entities it drew on and, for email drafting, email_to_name/email_to_address when known — instead of a bare action_card, which is reserved for work only the human can do.'
      )
  ),
  updated_at = now()
where is_system = true
  and slug in ('triage', 'standup-sync')
  and not exists (
    select 1
    from jsonb_array_elements_text(coalesce(agent_config -> 'context_rules', '[]'::jsonb)) as r(rule)
    where rule like 'work_proposal:%'
  );
