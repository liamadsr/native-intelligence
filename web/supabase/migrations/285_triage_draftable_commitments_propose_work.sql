-- Migration 285: triage proposes WORK for the user's draftable commitments.
--
-- Applied to prod on 2026-09-28, the night before the first Monday of
-- auto-attempt, so Monday's meetings run the fixed prompt.
--
-- What the ledger showed (21 days to 2026-09-28, Dial8 + Corvanne, the system
-- triage skill c61c5dc6 behind all three triage flows): triage filed 81
-- distinct "create action" proposals (118 verdict entries; the daily sweep
-- re-decides). 29 of the 81 had a draftable shape — 11 writer (draft a doc,
-- spec, deck, plan), 4 researcher (investigate and summarize), 14
-- correspondent (an email or message the user would send) — and 2 of those
-- were someone else's commitment, so 27 should have been work proposals. Triage
-- emitted a work_proposal for only 5 items in the window, and none reached the
-- user as work:
--
--   1. It ACCEPTS the commitment and ALSO lists the work_proposal with the same
--      proposal_id. applyVerdict drops a needs_user item whose proposal_id was
--      already carded by a decision (verdict-apply.ts, "1e-iii: DEDUPE
--      needs_user against already-carded decisions"), so the action card wins
--      and the work proposal vanishes. Three of the four linked ones landed as
--      plain action cards and expired untouched.
--   2. "A person only they can talk to" is read as covering correspondence:
--      "Follow up with Kim" became an action_card because "only Liam can drive
--      this personal relationship" — but drafting the message is the agent's
--      job; sending it stays the user's.
--   3. confidence on a needs_user item is optional and was set 0.7-0.75 (or
--      not at all) on most work proposals; the attempt gate refuses anything
--      under the verdict's trust floor: 0.85 on Dial8's flow, which sets it,
--      and 0.8 on Corvanne's flows, which set none and inherit the workspace
--      trust policy's actions floor (verdict-apply.ts resolveTrust). A work
--      proposal with no confidence is read as 0.
--      (Corrected 2026-09-28 after the migration was applied; the header
--      first said "0.85 in both workspaces". The SQL below is unchanged.)
--
-- The fix, in the prompt: for a commitment that passes the accept bar
-- AND is draftable, triage leaves it OUT of `decisions` and lists it as a
-- needs_user work_proposal carrying its proposal_id, role, expects, a quoted
-- trigger and a calibrated confidence. Leaving the proposal pending (rather
-- than accepting or dismissing it) is deliberate:
--   - accepting it files the action card that replaces the work (point 1);
--   - dismissing it strips the work of its grounding (the attempt gate refuses
--     a proposal that is dismissed, auto-attempt.ts groundedCapture);
--   - pending, it anchors the attempt: the gate grounds on its trigger_quote,
--     and a re-triage (the daily sweep) converges — the attempt reuses its run
--     by fire key attempt:<proposal_id>, and a pending card for the same
--     proposal is unique (attention_item_pending_proposal_uidx, migration 171).
--   A work card the user DISMISSES would leave its proposal pending, so
--   Corvanne's daily sweep could card it again until the 30-day stale rule
--   cleared it. The companion code change closes that: dismissing a
--   work_proposal card dismisses its pending proposal
--   (src/app/api/account/attention-items/route.ts).
--
-- Everything not draftable is untouched: the accept bar, the ownership gate,
-- dedupe, metadata corrections and action cards read exactly as before.
--
-- Same shape as migrations 198 and 281: a guarded prose append on the SYSTEM
-- triage row and a marker-prefixed context_rule, both idempotent. The two
-- workspace copies of `triage` (Dial8, Corvanne; is_system = false) are not
-- touched and are not used by any flow (every triage flow points at the system
-- row). standup-sync is out of scope.

update recipe set
  system_prompt = system_prompt || $dcw$

## Draftable commitments become work, not actions

This applies only to a proposal that already passes the accept bar above — real, explicitly the user's own, not already covered, worth doing. Everything else is decided exactly as before.

When such a commitment's deliverable is something an agent can produce from the workspace alone, propose it as WORK instead of accepting it:

- **researcher** — look into, investigate, research, compare, find out or size something, answerable from the workspace and the web. `expects: [{ "type": "document", "min": 1 }]`, `deliverable_hint: "document"`.
- **writer** — draft, write, update, put together or summarize a document: a spec, a plan, a brief, a deck's content, a list, a diagram described in text. `expects: [{ "type": "document", "min": 1 }]`, `deliverable_hint: "document"`.
- **correspondent** — send, email, follow up with, ask, notify, reply to or reach out to someone, where the substance is a message the user would send. `expects: [{ "type": "email_draft", "min": 1 }]`, `deliverable_hint: "email_draft"`. The agent only drafts; the user reviews and sends. "Only the user can send it" or "it's their relationship" is NOT a reason to make it an action_card — drafting it is the work.

For each one:

1. **Leave it out of `decisions`** — neither accept nor dismiss it. This is the one exception to "a decision for every proposal": accepting it files an action card that replaces your work proposal, and dismissing it removes the grounding the work needs. It stays pending as the work's anchor.
2. **Add a `needs_user` item** with `kind: "work_proposal"`, `proposal_id` set to that proposal's id, a short imperative `title`, `role`, `expects`, `payload.deliverable_hint`, and a self-contained `payload.task` (who, what, the context and names inline, the desired output; for email, `email_to_name` / `email_to_address` when known). In `why`, quote the proposal's trigger_quote verbatim, in double quotes.
3. **Set `confidence`** to how sure you are that (a) the user committed to this and (b) the agent can produce the artifact from the workspace alone — it knows the recipient, subject or sources it needs. Use 0.85 or higher only when both clearly hold. Lower is fine: the item stays a card the user starts with one click. Never leave `confidence` out.

NOT draftable — decide these exactly as before, as actions or cards:
- meetings and calls: join, attend, set up or schedule a call, regroup, discuss;
- access, tickets and system changes: grant access, submit a ticket, attach billing, push to an environment, set something up locally, export from a database;
- sending or sharing an existing file the agent cannot reach: a recording, code, a config file, a build;
- decisions, approvals, and waiting on someone else;
- code changes (a developer's work is not attempted; file it as an action, as today);
- anything mixing a draftable part with a human-only part ("regroup, then send the package") — decide it as before.

The ownership gate still comes first: a draftable item that is not explicitly the user's own is dismissed as `not yours`, never proposed as work. The same restraint applies — work proposals count toward the one or two things in needs_user, like any card.

If a pending proposal you see was already proposed as work in an earlier run, propose it again the same way: the system recognizes it and neither starts nor cards it twice.$dcw$,
  updated_at = now()
where is_system = true
  and slug = 'triage'
  and position('## Draftable commitments become work' in system_prompt) = 0;

update recipe set
  agent_config = jsonb_set(
    coalesce(agent_config, '{}'::jsonb),
    '{context_rules}',
    coalesce(agent_config -> 'context_rules', '[]'::jsonb) ||
      jsonb_build_array(
        'draftable_work: a proposal that passes the accept bar and whose deliverable an agent can produce from the workspace (researcher: investigate + summarize; writer: draft a document; correspondent: draft a message the user would send) is NOT accepted — leave it out of decisions and list it as a needs_user work_proposal with its proposal_id, role, expects, deliverable_hint, a self-contained payload.task, the trigger_quote quoted verbatim in why, and confidence (0.85+ only when the commitment is clearly the user''s and the agent has what it needs). Meetings, access/tickets/system changes, sharing existing files, decisions, code and mixed items are decided exactly as before.'
      )
  ),
  updated_at = now()
where is_system = true
  and slug = 'triage'
  and not exists (
    select 1
    from jsonb_array_elements_text(coalesce(agent_config -> 'context_rules', '[]'::jsonb)) as r(rule)
    where rule like 'draftable_work:%'
  );
