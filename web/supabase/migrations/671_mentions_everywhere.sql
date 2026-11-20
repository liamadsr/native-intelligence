-- ============================================================
-- 671: comments @-mention teammates and records, and a mentioned teammate is
-- told (docs/plans/mentions-everywhere.md, decisions 2 and 4).
-- ============================================================
--   comment.mentions         the workspace members a comment @-mentions (member
--                            ids, at most 50), as team_chat_message.mentions
--                            holds them (474).
--   comment.record_mentions  the records it @-mentions, as its words show them:
--                            [{ "type", "id", "label" }], at most 50, the one
--                            mention format (480's, on team chat messages).
--                            Written by the comment routes after fencing each
--                            for the author (src/lib/comment-mentions.ts); the
--                            same records are `mentions` edges in entity_link
--                            from the record the comment is on.
--   notification.type        + 'mentioned': a teammate @-mentioned in a comment,
--                            a document, or a description or note. In-app, like
--                            the comment notices; no new channel.
--
-- Old comments keep empty defaults: nothing is rewritten.
-- Additive. Idempotent. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

alter table public.comment
  add column if not exists mentions uuid[] not null default '{}',
  add column if not exists record_mentions jsonb not null default '[]'::jsonb;

alter table public.comment drop constraint if exists comment_mentions_max;
alter table public.comment
  add constraint comment_mentions_max check (cardinality(mentions) <= 50);

alter table public.comment drop constraint if exists comment_record_mentions;
alter table public.comment
  add constraint comment_record_mentions check (
    jsonb_typeof(record_mentions) = 'array' and jsonb_array_length(record_mentions) <= 50
  );

comment on column public.comment.mentions is
  'The workspace members this comment @-mentions (member ids). Fenced to the workspace by the comment routes.';
comment on column public.comment.record_mentions is
  'The records this comment @-mentions: [{type,id,label}], each fenced for the author before it is stored.';

-- 642's list, plus 'mentioned'.
alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'capture_shared', 'comment_added',
  'comment_reply', 'decision_confirmed', 'cycle_started', 'project_status_changed', 'meeting_starting_soon',
  'contact_followup_due', 'flow_run_output', 'reminder', 'work_needs_you', 'work_failed', 'agent_digest',
  'workspace_merged', 'agent_check_in', 'agent_look_ahead', 'agent_message', 'team_chat_message',
  'meeting_waiting', 'email_send_failed', 'mentioned'
])) not valid;
alter table public.notification validate constraint notification_type_check;

-- ============================================================
-- Sequences and prospect lists became @-mentionable (graph endpoints). Both
-- are every member's, so their entity_link edges need no fence and no policy
-- changes here. Teams stay search-only: a private team's edges would need
-- entity_visible_to and the entity_link policies redefined, which is its own
-- migration (their latest definitions are 664's and 522's).

-- ============================================================
-- Sharing an agent chat by mention (JOB 2): conversation_share.
-- ============================================================
-- A chat with the agent is its owner's alone (chat_conversations RLS). Decision
-- 1: mentioning your own chat where teammates read it lets those readers open
-- it, read only. The share is a row here, made by the owner, naming a workspace
-- member as grantee; src/lib/chat/conversation-share.ts writes it, called from
-- applyCommentMentions for a mentioned conversation and the teammates mentioned
-- beside it. Nothing of the chat is copied; the row records who may be shown it.
create table if not exists public.conversation_share (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  shared_by uuid not null references auth.users(id) on delete cascade,
  grantee_member_id uuid not null references public.member(id) on delete cascade,
  source text not null default 'mention' check (source in ('mention')),
  created_at timestamptz not null default now(),
  unique (conversation_id, grantee_member_id)
);

create index if not exists conversation_share_grantee_idx on public.conversation_share (grantee_member_id);
create index if not exists conversation_share_conversation_idx on public.conversation_share (conversation_id);

comment on table public.conversation_share is
  'A read-only share of an agent chat (671), made by the chat owner to a workspace member by @-mentioning the chat (decision 1). Holds ids only; chat_conversations and chat_messages stay owner-only under RLS.';

alter table public.conversation_share enable row level security;

-- The owner sees their own shares; a grantee sees the shares made to them.
drop policy if exists conversation_share_select on public.conversation_share;
create policy conversation_share_select on public.conversation_share
  for select
  using (
    shared_by = (select auth.uid())
    or exists (select 1 from public.member m where m.id = grantee_member_id and m.user_id = (select auth.uid()))
  );

-- Only the conversation's owner may share it, and only as themselves.
drop policy if exists conversation_share_insert on public.conversation_share;
create policy conversation_share_insert on public.conversation_share
  for insert
  with check (
    shared_by = (select auth.uid())
    and exists (
      select 1 from public.chat_conversations cc
      where cc.id = conversation_id and cc.user_id = (select auth.uid()) and cc.workspace_id = conversation_share.workspace_id
    )
    -- Only to a member of the conversation's own workspace.
    and exists (select 1 from public.member m where m.id = grantee_member_id and m.workspace_id = conversation_share.workspace_id)
  );

-- The owner may un-share.
drop policy if exists conversation_share_delete on public.conversation_share;
create policy conversation_share_delete on public.conversation_share
  for delete
  using (shared_by = (select auth.uid()));

revoke all on table public.conversation_share from public, anon;
grant select, insert, delete on table public.conversation_share to authenticated;
grant select, insert, update, delete on table public.conversation_share to service_role;

-- Reading a shared chat is NOT opened here: chat_conversations and
-- chat_messages stay their owner's alone under RLS (many reads rely on that).
-- A grantee's read goes through a server route that checks this table.

commit;

notify pgrst, 'reload schema';
