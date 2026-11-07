-- ============================================================
-- 351: remove the idle seeded loops and the work bots that only fronted them
-- ============================================================
-- Decision, 2026-10-17 (Liam): a new workspace is seeded with Triage alone.
-- Weekly groom ('seed:groom'), Morning brief ('seed:brief') and the Commitment
-- reconciler ('seed:reconcile') used to be seeded too, switched off; on PROD
-- each was on in exactly one workspace of ~147. Every seeded groom and brief
-- loop also got its own fronts_only work bot (migration 302,
-- flow-bot.ts backfillFlowBot), so most of PROD's fronts_only bots front a
-- loop nobody turned on. Their skills (groom, brief, reconcile) stay in the
-- library as on-demand skills; nothing here touches recipes.
--
-- Apply after the web deploy that stops seeding them (branch
-- claude/builtins-cleanup). Applying earlier does no harm: old code would
-- only seed these loops, and their bots, into workspaces created in between,
-- and a re-run of this file removes them.
--
-- In order:
--   1. Seeded groom, brief and reconcile loops that are switched off AND have
--      never run are deleted. Kept: any that is on (a person chose it), and any
--      that has a flow_run or an agent_run, so no run history goes. What
--      references flow (checked on DEV's catalog):
--        flow_run.flow_id          ON DELETE CASCADE  (none exist: fenced)
--        agent_run.flow_id         ON DELETE SET NULL (none exist: fenced)
--      and through flow_run, attention_item.source_flow_run_id and
--      tracked_job.flow_run_id (both SET NULL), which cannot apply because
--      no deleted loop has a run. The seeded Triage loop is never touched.
--   2. fronts_only work bots (never a system teammate) that front no loop and
--      that nothing points at are deleted: the bots step 1 freed, plus any
--      other unused one (the same test retireWorkBotIfUnused applies when a
--      loop drops its bot, made stricter). What references ai_team_member:
--        chat_conversations.ai_team_member_id   CASCADE  (a thread: kept)
--        agent_memory.ai_team_member_id         CASCADE  (memories: kept)
--        ai_team_member_skill.ai_team_member_id CASCADE  (skills a person
--                                                         gave it: kept)
--        chat_conversations.agent_teammate_id   SET NULL (kept)
--        tracked_job.ai_team_member_id          SET NULL (its Activity face: kept)
--        agent_run.ai_team_member_id            SET NULL (kept)
--        actions.assignee_ai_member_id          SET NULL (an assignment: kept)
--        bot_relay.teammate_id                  SET NULL (kept)
--        flow.ai_team_member_id                 SET NULL (fronts a loop: kept)
--      plus notification.metadata ->> 'teammate_id' (a notice it sent: kept)
--      and agent_recipe_id: a bot built on a custom agent (Phase 6) speaks
--      for that agent, so only bots on the global 'loop-work-bot' anchor (or
--      none) go. A bot with ANY of those is kept, so this file deletes no row
--      but the bots themselves: no cascade fires and no column is nulled.
--      ai_team_member_protect_system only refuses deleting is_system rows,
--      and every row here is not is_system.
--
-- Idempotent: both steps are fenced on what they delete, so a second run
-- deletes nothing. Each step reports its count with RAISE NOTICE. This file
-- holds no backslash anywhere: one MCP transport decodes escapes, so the
-- applied SQL would differ from the file.
-- ============================================================

-- SET LOCAL holds for the transaction MCP apply_migration wraps this file in.
SET LOCAL lock_timeout = '5s';

do $$
declare
  v_flows integer;
  v_bots integer;
begin
  -- 1. Idle seeded loops: off, never run.
  delete from public.flow f
  where f.seed_key in ('seed:groom', 'seed:brief', 'seed:reconcile')
    and f.enabled = false
    and not exists (select 1 from public.flow_run r where r.flow_id = f.id)
    and not exists (select 1 from public.agent_run a where a.flow_id = f.id);
  get diagnostics v_flows = row_count;
  raise notice '351: deleted % idle seeded loops (groom, brief, reconcile)', v_flows;

  -- 2. Work bots nothing needs: front no loop, referenced by nothing.
  with noticed as materialized (
    select distinct n.metadata ->> 'teammate_id' as teammate_id
    from public.notification n
    where n.metadata ? 'teammate_id'
  ),
  anchor as (
    select r.id
    from public.recipe r
    where r.slug = 'loop-work-bot' and r.workspace_id is null
  )
  delete from public.ai_team_member m
  where m.fronts_only = true
    and m.is_system = false
    and (m.agent_recipe_id is null or m.agent_recipe_id in (select id from anchor))
    and not exists (select 1 from public.flow f where f.ai_team_member_id = m.id)
    and not exists (
      select 1 from public.chat_conversations c
      where c.ai_team_member_id = m.id or c.agent_teammate_id = m.id
    )
    and not exists (select 1 from public.agent_memory x where x.ai_team_member_id = m.id)
    and not exists (select 1 from public.ai_team_member_skill x where x.ai_team_member_id = m.id)
    and not exists (select 1 from public.tracked_job x where x.ai_team_member_id = m.id)
    and not exists (select 1 from public.agent_run x where x.ai_team_member_id = m.id)
    and not exists (select 1 from public.actions x where x.assignee_ai_member_id = m.id)
    and not exists (select 1 from public.bot_relay x where x.teammate_id = m.id)
    and not exists (select 1 from noticed x where x.teammate_id = m.id::text);
  get diagnostics v_bots = row_count;
  raise notice '351: deleted % unused fronts_only work bots', v_bots;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Check, after applying:
--   select seed_key, enabled, count(*) from public.flow
--   where seed_key is not null group by 1, 2 order by 1, 2;
--     → seed:triage as before; groom/brief/reconcile only rows that are on
--       or have run
--   select count(*) from public.ai_team_member m
--   where m.fronts_only and not m.is_system
--     and not exists (select 1 from public.flow f where f.ai_team_member_id = m.id);
--     → only bots kept for a reference listed above
--   select count(*) from public.flow f
--   where f.ai_team_member_id is not null
--     and not exists (select 1 from public.ai_team_member m where m.id = f.ai_team_member_id);
--     → 0 (the FK forbids it anyway)
-- ═══════════════════════════════════════════════════════════════════════════
