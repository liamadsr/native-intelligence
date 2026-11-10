-- ============================================================
-- 513: "Ana shared Q3 plan with you" lands in the Inbox (the shared entity
-- layer, FU-E).
-- ============================================================
-- A new grant (492) is now an activity row (488), so the cross-kind feed
-- says it: the person a record was shared with finds it in their Inbox, and
-- the record's History says who shared it.
--
--   action 'shared'   one row per grant added, on the record:
--                       actor     who shared it (granted_by; 488's actor
--                                 rule says member, agent or system);
--                       subject   the member it was shared with, for a grant
--                                 to ONE member: that is the Inbox's row;
--                       detail    {level, grantee_kind, source}: no title, no
--                                 text, no grantee id beyond the subject (488's
--                                 rule: labels are read through the viewer's
--                                 own RLS when the feed answers).
--   A grant to a team or a channel has no subject: it reaches many people
--   (a channel's readers can be the whole workspace), so it shows in the
--   record's History and in no one's Inbox. A share by @-mention already
--   tells the channel in the message itself.
--
-- Changing a grant's level, or removing one, writes nothing: the Inbox row
-- of a removed grant drops out on its own (the feed reads each record's
-- label through the viewer's RLS, and they can no longer read it).
--
-- Cost: one statement-level trigger (the transition table, 488's way): one
-- insert per statement however many grants it adds. Logging never fails the
-- grant (a WARNING, as 488).
--
-- After 488, 492, 497 (its 'updated' action). Idempotent. No backslashes
-- anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

alter table public.entity_activity drop constraint if exists entity_activity_action_check;
alter table public.entity_activity add constraint entity_activity_action_check check (action in (
  'created', 'renamed', 'status_changed', 'assigned', 'archived', 'restored',
  'mentioned', 'commented', 'linked', 'updated', 'shared'
));

create or replace function public.entity_activity_entity_access_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
    select n.workspace_id, n.entity_type, n.entity_id, 'shared',
           -- A grant names who made it; a server write that names no agent is still theirs.
           case when a.actor_kind = 'system' and n.granted_by is not null then 'member' else a.actor_kind end,
           coalesce(n.granted_by, public.entity_activity_member(a.actor_user_id, n.workspace_id)),
           case when n.grantee_kind = 'member' then n.grantee_member_id end,
           jsonb_build_object('level', n.level, 'grantee_kind', n.grantee_kind, 'source', n.source)
      from new_rows n
     where public.entity_activity_writable(n.workspace_id)
       -- Never "you shared this with yourself".
       and not (n.grantee_kind = 'member' and n.grantee_member_id is not distinct from n.granted_by);
  exception when others then
    raise warning 'entity_activity (entity_access insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function public.entity_activity_entity_access_insert() from public, anon, authenticated;

drop trigger if exists entity_activity_insert on public.entity_access;
create trigger entity_activity_insert
  after insert on public.entity_access
  referencing new table as new_rows
  for each statement execute function public.entity_activity_entity_access_insert();

notify pgrst, 'reload schema';
