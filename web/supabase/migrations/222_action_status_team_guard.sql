-- 222: actions.status_id must belong to actions.team_id
--
-- The workspace-move integrity sweep (2026-08-04) found actions whose
-- workflow state belongs to a DIFFERENT team in the same workspace — relics
-- of an old team-change path that re-pointed team_id without remapping
-- status_id. Nothing in the current app writes team_id on update, but the
-- invariant was never enforced anywhere except inside the move engine
-- (migration 221), so any future writer could silently recreate the drift.
--
-- Fix at the schema layer, same shape as generate_action_identifier:
--   1. A BEFORE trigger remaps status_id whenever an insert/update would
--      leave it pointing at another team's ladder — matched by name, then
--      category, then the team's default, then any state of the team, and
--      as a last resort left unchanged (NOT NULL + FK must still hold).
--      Writers that set a consistent (team_id, status_id) pair — the move
--      engine, the status picker — hit the fast path and are untouched.
--   2. A one-off repair heals the existing drift rows with the same ladder.
--
-- The trigger fires on INSERT and on UPDATE OF team_id/status_id only, so
-- ordinary field edits pay nothing.

CREATE OR REPLACE FUNCTION public.enforce_action_status_team()
RETURNS trigger AS $$
DECLARE
  v_state_team uuid;
  v_name public.workflow_state.name%TYPE;
  v_category public.workflow_state.category%TYPE;
BEGIN
  IF new.status_id IS NULL OR new.team_id IS NULL THEN
    RETURN new;
  END IF;

  SELECT ws.team_id, ws.name, ws.category
  INTO v_state_team, v_name, v_category
  FROM public.workflow_state ws
  WHERE ws.id = new.status_id;

  -- Fast path: unknown state (let the FK speak) or already consistent.
  IF v_state_team IS NULL OR v_state_team = new.team_id THEN
    RETURN new;
  END IF;

  new.status_id := COALESCE(
    (SELECT ws2.id FROM public.workflow_state ws2
     WHERE ws2.team_id = new.team_id AND lower(ws2.name) = lower(v_name)
     ORDER BY ws2.sort_order ASC, ws2.id ASC LIMIT 1),
    (SELECT ws2.id FROM public.workflow_state ws2
     WHERE ws2.team_id = new.team_id AND ws2.category = v_category
     ORDER BY ws2.sort_order ASC, ws2.id ASC LIMIT 1),
    (SELECT ws2.id FROM public.workflow_state ws2
     WHERE ws2.team_id = new.team_id AND ws2.is_default
     ORDER BY ws2.sort_order ASC, ws2.id ASC LIMIT 1),
    (SELECT ws2.id FROM public.workflow_state ws2
     WHERE ws2.team_id = new.team_id
     ORDER BY ws2.sort_order ASC, ws2.id ASC LIMIT 1),
    new.status_id);

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS action_status_team_guard ON public.actions;
CREATE TRIGGER action_status_team_guard
  BEFORE INSERT OR UPDATE OF team_id, status_id ON public.actions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_action_status_team();

-- One-off repair of pre-existing drift, same ladder. The SET fires the new
-- trigger, which sees the now-consistent pair and no-ops.
UPDATE public.actions a
SET status_id = COALESCE(
    (SELECT ws2.id FROM public.workflow_state ws2
     WHERE ws2.team_id = a.team_id AND lower(ws2.name) = lower(ws1.name)
     ORDER BY ws2.sort_order ASC, ws2.id ASC LIMIT 1),
    (SELECT ws2.id FROM public.workflow_state ws2
     WHERE ws2.team_id = a.team_id AND ws2.category = ws1.category
     ORDER BY ws2.sort_order ASC, ws2.id ASC LIMIT 1),
    (SELECT ws2.id FROM public.workflow_state ws2
     WHERE ws2.team_id = a.team_id AND ws2.is_default
     ORDER BY ws2.sort_order ASC, ws2.id ASC LIMIT 1),
    (SELECT ws2.id FROM public.workflow_state ws2
     WHERE ws2.team_id = a.team_id
     ORDER BY ws2.sort_order ASC, ws2.id ASC LIMIT 1),
    a.status_id)
FROM public.workflow_state ws1
WHERE ws1.id = a.status_id
  AND a.team_id IS NOT NULL
  AND ws1.team_id <> a.team_id;

COMMENT ON FUNCTION public.enforce_action_status_team() IS
  'BEFORE trigger on actions: when an insert/update would leave status_id '
  'pointing at another team''s workflow state, remap it onto the action''s '
  'own team by name, then category, then the team default (the same ladder '
  'the cross-workspace move engine uses). Consistent writes are untouched.';
