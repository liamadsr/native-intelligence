-- ============================================================
-- 518: Recent reads in index order (the shared entity layer, follow-up F).
-- ============================================================
-- Recent (the feed's actor=me: workspace, actor member, newest first) was
-- served by 488's (actor_member_id, created_at desc) index. While a member's
-- history was a few days long that was fine; with the backfill (516) a
-- member holds months of rows, and the planner ANDed that index with the
-- workspace one, read every one of the member's rows (each through the
-- log's row policy, 489) and sorted them: 28 ms for 937 rows on DEV,
-- growing with the history. This index matches the query exactly
-- (workspace, member, created_at desc, id desc), so a page reads its 80
-- rows in order and stops: 3.6 ms on DEV, whatever the history's length.
-- It replaces 488's actor index, whose every use it serves (a member
-- belongs to one workspace, so the feed always names both).
--
-- After 488 and 516. Idempotent. No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

create index if not exists entity_activity_actor_recent_idx
  on public.entity_activity (workspace_id, actor_member_id, created_at desc, id desc)
  where actor_member_id is not null;

drop index if exists public.entity_activity_actor_idx;

notify pgrst, 'reload schema';
