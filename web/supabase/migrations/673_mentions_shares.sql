-- ============================================================
-- 673: what "mentions everywhere" left undone (docs/plans/mentions-everywhere.md):
--   A. teams and knowledge packages as @-mentions: their graph edges fenced;
--   B. opening an agent chat that was shared by a mention;
--   C. sharing a mail thread with a person by a mention.
-- ============================================================
-- On top of 671 (comment mentions, conversation_share) and 672. It redefines
-- NO existing function and NO existing policy: every rule here is a new
-- function, a new table, or a new RESTRICTIVE policy beside the ones there
-- (the way 624 fenced the Studio's edges), so nothing a later migration
-- defined (entity_visible_to: 664; entity_link_select/insert: 522) is touched.
--
-- Additive. Idempotent. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

-- ── A. Teams and knowledge packages: graph edges ────────────────────────────

-- team_package_entity_visible_to: one team's or knowledge package's own read
-- rule, for an explicit user (as 624's studio_entity_visible_to is the
-- Studio's). A team: a member of its workspace, and of the team when it is
-- private (the team table's "Users can view accessible teams"). A package:
-- package_visible_to (its visibility, its creator, its shares). No user: no.
create or replace function public.team_package_entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ws uuid;
  v_private boolean;
  v_member uuid;
begin
  if p_id is null or p_user is null then return false; end if;
  -- A signed-in caller asks only about themself.
  if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;

  if p_type = 'team' then
    select t.workspace_id, t.is_private into v_ws, v_private from public.team t where t.id = p_id;
    -- Gone, or not in the workspace asked about: not visible.
    if v_ws is null or (p_workspace is not null and v_ws <> p_workspace) then return false; end if;
    select m.id into v_member from public.member m where m.workspace_id = v_ws and m.user_id = p_user limit 1;
    if v_member is null then return false; end if;
    if coalesce(v_private, false) = false then return true; end if;
    return exists (select 1 from public.team_member tm where tm.team_id = p_id and tm.member_id = v_member);
  elsif p_type = 'knowledge_package' then
    select kp.workspace_id into v_ws from public.knowledge_package kp where kp.id = p_id;
    if v_ws is null or (p_workspace is not null and v_ws <> p_workspace) then return false; end if;
    return public.package_visible_to(p_id, p_user);
  end if;
  return false;
end;
$$;

comment on function public.team_package_entity_visible_to(text, uuid, uuid, uuid) is
  'A team''s or knowledge package''s read rule for one record and one user (673): what the restrictive entity_link policies below ask.';

revoke all on function public.team_package_entity_visible_to(text, uuid, uuid, uuid) from public, anon;
grant execute on function public.team_package_entity_visible_to(text, uuid, uuid, uuid) to authenticated, service_role;

-- An edge with a team or a package at either end follows that record's rule.
-- RESTRICTIVE, beside 522's entity_link_select / entity_link_insert (which
-- stay exactly as they are): a row must pass those AND these.
drop policy if exists entity_link_team_package_select on public.entity_link;
create policy entity_link_team_package_select on public.entity_link
  as restrictive
  for select
  using (
    (source_type not in ('team', 'knowledge_package')
     or public.team_package_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type not in ('team', 'knowledge_package')
     or public.team_package_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_team_package_insert on public.entity_link;
create policy entity_link_team_package_insert on public.entity_link
  as restrictive
  for insert
  with check (
    (source_type not in ('team', 'knowledge_package')
     or public.team_package_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type not in ('team', 'knowledge_package')
     or public.team_package_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_team_package_update on public.entity_link;
create policy entity_link_team_package_update on public.entity_link
  as restrictive
  for update
  using (
    (source_type not in ('team', 'knowledge_package')
     or public.team_package_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type not in ('team', 'knowledge_package')
     or public.team_package_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  )
  with check (
    (source_type not in ('team', 'knowledge_package')
     or public.team_package_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type not in ('team', 'knowledge_package')
     or public.team_package_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_team_package_delete on public.entity_link;
create policy entity_link_team_package_delete on public.entity_link
  as restrictive
  for delete
  using (
    (source_type not in ('team', 'knowledge_package')
     or public.team_package_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type not in ('team', 'knowledge_package')
     or public.team_package_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

-- ── B. A shared agent chat ──────────────────────────────────────────────────

-- No schema here: a grantee reads a shared chat through a server route (GET /api/account/conversations/[id]/shared) that checks conversation_share (671); chat_conversations and chat_messages stay owner-only under RLS.

-- ── C. A mail thread shared with a person ───────────────────────────────────
-- Decision 1 (docs/plans/mentions-everywhere.md): @-mentioning your OWN mail
-- thread where teammates read it shares it with them, view only. Mail is not
-- stored, so the share is the SAME live share 646 built (read from the owner's
-- mailbox on each open, limited to the message ids frozen at share time),
-- widened from a team-chat channel (email_share) to a PERSON (a workspace
-- member). email_thread_share stays ids only, exactly as 646's rule: NO
-- subject, body, snippet, names or addresses. Who shared which thread with
-- which teammate, and the frozen ids, nothing of the mail.
--
--   email_thread_share   one share: the owner (owner_user_id) shared the
--                         thread (provider_thread_id, in the mailbox
--                         account_id, its index row thread_index_id when it has
--                         one) with a workspace member (grantee_member_id).
--                         message_ids are the thread's messages at that moment,
--                         frozen (a later reply stays private unless shared
--                         again), same shape and check as 646. source is always
--                         'mention'; source_type/source_id name what mentioned
--                         it (e.g. 'comment' + the comment id), nullable.
--                         revoked_at: un-shared (access ends at once).
--                         No client grants and no policies: the server reads
--                         and writes it with the service role, behind routes
--                         that check the owner (sharing, un-sharing) and the
--                         grantee (reading) first, exactly as email_share does
--                         (src/lib/email-share/member-share.ts, the routes
--                         under src/app/api/account/email/thread-shares/).
-- One live share per (owner, thread, grantee): a partial unique index where
-- revoked_at is null (a re-mention refreshes the frozen ids in place; a revoked
-- row never blocks a fresh share).

create table if not exists public.email_thread_share (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid references public.connected_account(id) on delete set null,
  provider text not null check (provider in ('google', 'microsoft')),
  provider_thread_id text not null check (char_length(provider_thread_id) between 1 and 512),
  thread_index_id uuid references public.email_thread_index(id) on delete set null,
  message_ids text[] not null check (cardinality(message_ids) between 1 and 100 and array_position(message_ids, null) is null),
  grantee_member_id uuid not null references public.member(id) on delete cascade,
  source text not null default 'mention' check (source in ('mention')),
  source_type text,
  source_id uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- One live share per owner, thread and grantee (a re-mention refreshes it).
create unique index if not exists email_thread_share_live_key
  on public.email_thread_share (owner_user_id, provider_thread_id, grantee_member_id)
  where revoked_at is null;

-- The grantee's live shares (the reader's lookup, by thread index row and by id).
create index if not exists email_thread_share_grantee_idx
  on public.email_thread_share (grantee_member_id, thread_index_id)
  where revoked_at is null;

-- The owner's live shares of one thread (their chips, their revokes).
create index if not exists email_thread_share_owner_thread_idx
  on public.email_thread_share (owner_user_id, workspace_id, provider_thread_id)
  where revoked_at is null;

comment on table public.email_thread_share is
  'An email thread shared with a workspace member by an @-mention (673, decision 1). Holds ids only, never mail: the mail is read live from the owner''s mailbox on each open, limited to message_ids, which are frozen at share time. Service role only.';
comment on column public.email_thread_share.owner_user_id is 'The mail''s owner: only their own thread is ever shared (verified on write, never trusted from the caller).';
comment on column public.email_thread_share.grantee_member_id is 'The workspace member the thread is shared with: they read it live, view only, while this row is not revoked.';
comment on column public.email_thread_share.message_ids is 'The thread''s message ids frozen at share time (same bound and rule as email_share, 646): only these are ever read. Ids only, never mail.';
comment on column public.email_thread_share.source_type is 'What mentioned the thread (e.g. the comment that carried the @-mention), for provenance; nullable. source_id is its id.';

alter table public.email_thread_share enable row level security;
revoke all on table public.email_thread_share from public, anon, authenticated;
grant select, insert, update, delete on table public.email_thread_share to service_role;


commit;

notify pgrst, 'reload schema';
