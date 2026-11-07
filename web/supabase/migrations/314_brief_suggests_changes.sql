-- Migration 314: the Morning Brief stages its recommendations as suggestions
-- (docs/plans/suggestions-everywhere.md, Phase 6).
--
-- WHY: the brief already works out the moves ("GEN-297 … It's sitting in
-- Backlog; move it now or close it.") and then writes them as prose, so the
-- person has to go find the item. With suggest_changes (allowed in report mode)
-- each recommended move becomes a card in the brief itself: Accept, Dismiss, or
-- adjust the status, assignee or date first.
--
-- What lands, on the system `brief` skill only:
--   system_prompt   gains a "Suggest the moves" section (appended once).
--   agent_config    suggest_changes joins preferred_tools, and a context rule.
-- Idempotent: each change applies only when it isn't there yet.

UPDATE public.recipe
SET system_prompt = system_prompt || E'\n\n## Suggest the moves\nWhen "Needs you" recommends a change to a tracked item (move GEN-297 to Todo, push its due date, close or cancel it, reassign it, reprioritize it) or a new task for an untracked commitment, stage it with `suggest_changes` in ONE call, with `expires_in_days: 7` (tomorrow''s brief stages it again if it still matters). Put each returned marker on its own line right after the paragraph about that item, so the person can accept it right there; leave refused ones out and never mention them. Recommend only moves you''d stand behind; an item that just needs attention, not a change, gets no suggestion. Keep citing identifiers (GEN-117): they render as live chips.'
WHERE is_system = true AND category = 'skill' AND slug = 'brief'
  AND system_prompt NOT LIKE '%suggest_changes%';

UPDATE public.recipe
SET agent_config = jsonb_set(
      jsonb_set(
        COALESCE(agent_config, '{}'::jsonb),
        '{preferred_tools}',
        COALESCE(agent_config -> 'preferred_tools', '[]'::jsonb) || '["suggest_changes"]'::jsonb
      ),
      '{context_rules}',
      COALESCE(agent_config -> 'context_rules', '[]'::jsonb)
        || '["Recommended moves on tracked items (status, due date, assignee, priority) and new tasks for untracked commitments go through suggest_changes, one call, expires_in_days 7, each marker on its own line after its paragraph."]'::jsonb
    )
WHERE is_system = true AND category = 'skill' AND slug = 'brief'
  AND NOT (COALESCE(agent_config -> 'preferred_tools', '[]'::jsonb) ? 'suggest_changes');
