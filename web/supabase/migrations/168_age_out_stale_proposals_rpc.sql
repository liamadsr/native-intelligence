-- Migration 168: age_out_stale_proposals RPC (loop-closure Phase 2, E1).
--
-- The graveyard-drain sweep needs to DISMISS stale pending proposals while
-- MERGING an aged_out marker into their existing `extra` — not replacing it.
-- A whole-column write would clobber load-bearing extra keys (e.g.
-- assignee_ai_member_id), breaking reversibility. PostgREST can't express a
-- per-row `extra || marker` in a bulk update, so this RPC does the merge in one
-- atomic, guarded statement.
--
-- SAFETY — the WHERE clause is the full stale predicate, so the RPC can only
-- ever touch genuinely-abandoned rows:
--   * status = 'pending'
--   * top-level applied_at IS NULL AND result_entity_id IS NULL (not applied)
--   * extra->>'applied_at' IS NULL  ← NEW: a proposal whose side effect fired
--     but whose top-level status write was lost (a crash between applyChange's
--     side effect and the caller's status update) leaves a marker ONLY in
--     extra.applied_at. Excluding it means the sweep never masks an orphaned
--     partial-apply / already-fired external action. (Adversarial review: the
--     two-phase-commit gap.)
--   * created_at < cutoff
--   * not a demo/onboarding capture
--   * optional workspace scope
-- It only ever sets status='dismissed' and merges the marker — never deletes,
-- never touches the board. Reversible: status flips back; the marker is
-- provenance in extra alongside whatever was already there.
--
-- Returns the dismissed rows' ids + workspace_ids so the caller can tally.
-- SECURITY DEFINER + service-role-only callers (the cron + the admin route both
-- use the service client); execute is NOT granted to authenticated.

create or replace function public.age_out_stale_proposals(
  p_cutoff timestamptz,
  p_workspace_id uuid default null,
  p_limit integer default null
)
returns table (id uuid, workspace_id uuid)
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select pc.id
    from proposed_change pc
    where pc.status = 'pending'
      and pc.applied_at is null
      and pc.result_entity_id is null
      and (pc.extra ->> 'applied_at') is null
      and pc.created_at < p_cutoff
      and (p_workspace_id is null or pc.workspace_id = p_workspace_id)
      and not exists (
        select 1 from captures cap
        where cap.id = pc.capture_id
          and coalesce((cap.metadata ->> 'demo')::boolean, false) = true
      )
    order by pc.created_at asc
    limit case when p_limit is not null and p_limit > 0 then p_limit else null end
  )
  update proposed_change pc set
    status = 'dismissed',
    extra = coalesce(pc.extra, '{}'::jsonb) || jsonb_build_object(
      'aged_out', true,
      'aged_out_reason', 'stale — the meeting''s moment passed',
      'aged_out_cutoff', p_cutoff
    )
  from candidates c
  where pc.id = c.id
    -- Re-assert the guards at write time (CAS): a row applied between the CTE
    -- scan and the update is skipped, never dismissed.
    and pc.status = 'pending'
    and pc.applied_at is null
    and pc.result_entity_id is null
    and (pc.extra ->> 'applied_at') is null
  returning pc.id, pc.workspace_id;
$$;

-- Service-role only. The cron (getServiceClient) and admin route
-- (getAdminServiceClient) bypass RLS; no authenticated grant, so a normal user
-- can never invoke the bulk dismiss.
revoke all on function public.age_out_stale_proposals(timestamptz, uuid, integer) from public;
