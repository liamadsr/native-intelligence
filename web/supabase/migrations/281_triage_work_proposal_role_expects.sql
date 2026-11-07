-- Migration 281: work proposals name a ROLE and what they EXPECT back.
--
-- Sequence step 2 (B PR 1): the auto-attempt gate (B PR 3) will only attempt a
-- work_proposal that names a role from the closed set and says what artifact
-- the work must produce (`expects`) — the structural signal that a "decide X" /
-- "meet Y" item can never pass (follow-up §B.1 row 2). The verdict schema
-- (src/lib/flows/verdict-schema.ts) now accepts `role` and `expects` on a
-- needs_user work_proposal item; this migration teaches the two system verdict
-- skills to fill them in. Both stay OPTIONAL: an item without them is exactly
-- today's card with Start.
--
-- Same shape as migration 198: a guarded prose append on the system prompt and
-- a marker-prefixed context_rule, both idempotent.
--
-- FORK TRAP (from migrations 166/194/198): this touches the SYSTEM rows only
-- (is_system = true, slugs 'triage' and 'standup-sync'). A workspace COPY of
-- either skill (same slug, is_system = false — the prod database has two such
-- triage copies from before the verdict flip) keeps its own prompt and never
-- emits role/expects, so the gate will never attempt from its cards. That is
-- the safe direction; a loop that should attempt must point at the system row.

update recipe set
  system_prompt = system_prompt || $wpr$

## Who should do the work, and what it must produce

When you emit a `work_proposal`, also say WHO should do it and WHAT it must produce, so the system can route it to the right teammate and judge the result:

- `role` (optional) — one of `researcher` (find out and summarize), `writer` (draft a document), `developer` (change code, open a PR), `correspondent` (draft an email). Pick the role whose output the item needs; leave it out if none fits — an item with no role is never attempted automatically, it stays a card for the user.
- `expects` (optional) — the artifact the work must produce, as a short list: `[{ "type": "document", "min": 1 }]` for a brief or a draft doc, `[{ "type": "email_draft", "min": 1 }]` for an email, `[{ "type": "entity", "entity_type": "pr", "min": 1 }]` for code. Leave it out when a summary in the run's own words is enough.

Only set a role when the task is genuinely that role's shape. A "decide X", "meet Y" or "wait for Z" item has no role and no expected artifact — it is an action_card, not a work_proposal.$wpr$,
  updated_at = now()
where is_system = true
  and slug in ('triage', 'standup-sync')
  and position('## Who should do the work' in system_prompt) = 0;

update recipe set
  agent_config = jsonb_set(
    coalesce(agent_config, '{}'::jsonb),
    '{context_rules}',
    coalesce(agent_config -> 'context_rules', '[]'::jsonb) ||
      jsonb_build_array(
        'work_proposal_role: on a work_proposal, set role to the teammate whose output the item needs (researcher | writer | developer | correspondent) and expects to the artifact it must produce ([{type:"document",min:1}], [{type:"email_draft",min:1}], or [{type:"entity",entity_type:"pr",min:1}]); leave both out when no role fits — an item with no role stays a card for the user and is never attempted on its own.'
      )
  ),
  updated_at = now()
where is_system = true
  and slug in ('triage', 'standup-sync')
  and not exists (
    select 1
    from jsonb_array_elements_text(coalesce(agent_config -> 'context_rules', '[]'::jsonb)) as r(rule)
    where rule like 'work_proposal_role:%'
  );
