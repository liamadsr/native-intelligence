-- Migration 161: declare preconditions on data-hungry system skills (GEN-145).
--
-- Some catalog skills need a connected integration or populated data to produce
-- anything; without it they run and emit a hollow "found nothing" report. The
-- run-skill executor (src/lib/flows/skill-preconditions.ts) now checks a skill's
-- agent_config.preconditions before invoking the model and delivers an honest
-- empty-state ("needs a connected calendar — link it first") instead. This
-- migration attaches those preconditions to the skills that need them.
--
-- Merges into the existing agent_config JSONB (|| preserves every other key).
-- Idempotent: re-running sets the same value. Unknown keys are ignored by the
-- checker, so this is safe to ship ahead of / behind the code.
--
-- Precondition vocabulary: calendar_connected | inbox_synced | has_contacts |
-- has_captures | has_actions.

-- Morning Brief — its substance is the calendar + inbox + cross-workspace
-- history. With neither a calendar nor an inbox it has nothing to brief.
UPDATE public.recipe
SET agent_config = COALESCE(agent_config, '{}'::jsonb)
  || jsonb_build_object('preconditions', jsonb_build_array('calendar_connected'))
WHERE is_system = true AND category = 'skill' AND slug = 'brief';

-- Meeting Prep — prepares for UPCOMING calendar events; no calendar, nothing to
-- prep.
UPDATE public.recipe
SET agent_config = COALESCE(agent_config, '{}'::jsonb)
  || jsonb_build_object('preconditions', jsonb_build_array('calendar_connected'))
WHERE is_system = true AND category = 'skill' AND slug = 'meeting-prep';

-- Occasion Planner — plans around people + dates; needs contacts to have anyone
-- to plan for.
UPDATE public.recipe
SET agent_config = COALESCE(agent_config, '{}'::jsonb)
  || jsonb_build_object('preconditions', jsonb_build_array('has_contacts'))
WHERE is_system = true AND category = 'skill' AND slug = 'occasion';

-- Action-to-Email Bridge — turns actions into email drafts; needs a synced
-- inbox to draft from / send through.
UPDATE public.recipe
SET agent_config = COALESCE(agent_config, '{}'::jsonb)
  || jsonb_build_object('preconditions', jsonb_build_array('inbox_synced'))
WHERE is_system = true AND category = 'skill' AND slug = 'email-bridge';
