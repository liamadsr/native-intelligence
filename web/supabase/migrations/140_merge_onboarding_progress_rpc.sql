-- ====================================================================
-- 140: merge_onboarding_progress RPC (atomic JSONB deep-merge)
-- ====================================================================
--
-- Why this exists
-- ---------------
-- The onboarding PATCH route used to read member.onboarding_progress, merge the
-- incoming patch in JS, then write the whole blob back. When several writers
-- fire near-simultaneously — e.g. the guided tour marking two checklist steps at
-- one milestone WHILE the tour also persists its resume point — those requests
-- race: each reads the same baseline, and the last write wins, silently dropping
-- the others. The visible symptom was the "Getting started" ring freezing (a
-- step ticked locally but lost on the server, so it reverted on reload).
--
-- This function performs the entire read-modify-write in ONE atomic UPDATE so
-- concurrent callers compose instead of clobbering. It mirrors the route's merge
-- semantics exactly:
--   * top-level keys are SHALLOW-merged (incoming wins)         → jsonb `||`
--   * the nested `tutorial` object is DEEP-merged (one key at a  → `||` again,
--     time, never replacing sibling step flags)                    one level down
--
-- SECURITY INVOKER + an explicit auth.uid() scope: the function only ever
-- touches the caller's own member row for the given workspace, so it's safe to
-- expose to authenticated users (RLS still applies to the row, and the WHERE
-- clause pins user_id = auth.uid()).
--
-- Idempotent: drop+recreate. Non-destructive to data.

drop function if exists public.merge_onboarding_progress(uuid, jsonb);

create function public.merge_onboarding_progress(
  p_workspace_id uuid,
  p_patch jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  update member m
  set onboarding_progress =
    -- 1. shallow-merge all incoming top-level keys onto the existing blob …
    (coalesce(m.onboarding_progress, '{}'::jsonb) || p_patch)
    -- 2. … then, IF the patch carried a `tutorial` object, overwrite that one
    --    key with a DEEP merge so individual step flags aren't clobbered.
    || (
      case
        when jsonb_typeof(p_patch -> 'tutorial') = 'object' then
          jsonb_build_object(
            'tutorial',
            coalesce(m.onboarding_progress -> 'tutorial', '{}'::jsonb)
              || (p_patch -> 'tutorial')
          )
        else '{}'::jsonb
      end
    )
  where m.user_id = v_uid
    and m.workspace_id = p_workspace_id
  returning m.onboarding_progress into v_result;

  return v_result;
end;
$$;

grant execute on function public.merge_onboarding_progress(uuid, jsonb) to authenticated;
