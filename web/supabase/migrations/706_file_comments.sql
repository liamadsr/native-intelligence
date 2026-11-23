-- ============================================================
-- 706: comments on a file, pinned to a place on a page.
-- ============================================================
-- Why: Drive files (docs/plans/drive-files.md, phase 4): people comment on a
-- place on a PDF's page, @-mention teammates and are told, as they do on a
-- canvas (682) or a spreadsheet (675).
--
-- What lands:
--   file_comment          one row a comment: the file it is on, the thread
--                         (a reply names the thread's first comment), where
--                         on the page it is pinned (page from 1, x and y as
--                         fractions of the page's width and height, 0 to 1;
--                         none: the whole file), the words, the teammates it
--                         mentions, its author (a member), whether the
--                         assistant wrote it for them (via_agent, 692's
--                         rule), and when a thread was resolved and by whom.
--                         The file is an uploaded one (attachment_id) or one
--                         sent in team chat (the message and the file's
--                         object path), never a mail attachment: a comment
--                         on one would keep something of the mail (344).
--   who does what         a comment is read, and a thread is started or
--                         answered or resolved, by whoever can read the file
--                         at that moment: the file, read under the caller's
--                         own row security (attachments' policies, with 696's
--                         Drive upload rule; team_chat_message's for a chat
--                         file), so nothing here restates who reads a file.
--                         A comment is written and deleted as its author.
--   the guards            a before-update trigger in 682's and 681's rule:
--                         a comment keeps its file, its author, its thread,
--                         its place and its time; only its author changes its
--                         words (681); a resolver is recorded as themself.
--                         692's record_comment_agent_mark_guard keeps
--                         via_agent as it was made. Both hold a client's own
--                         token; the service role and a database owner are
--                         not held to them.
--   notification          its target list (688's, the newest) gains
--                         'attachment', so a notice can open the file. The
--                         notices go through the existing path
--                         (src/lib/record-comments/notify.ts), only to a
--                         member who can open the file then.
--
-- No realtime publication. Re-runnable. Its own transaction (begin ...
-- commit), so it is all or nothing however it is applied. No backslashes
-- anywhere in this file. After 696, 692 and 688. Each statement waits at most
-- 5 s for a lock; one that waits longer rolls the file back, to be applied
-- again.
-- ============================================================

begin;

SET LOCAL lock_timeout = '5s';

create table if not exists public.file_comment (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  attachment_id uuid references public.attachments(id) on delete cascade,
  chat_message_id uuid references public.team_chat_message(id) on delete cascade,
  chat_file_path text,
  parent_id uuid references public.file_comment(id) on delete cascade,
  page integer,
  x double precision,
  y double precision,
  body text not null,
  mentions jsonb not null default '[]'::jsonb,
  author_id uuid references public.member(id) on delete set null,
  via_agent boolean not null default false,
  resolved_at timestamptz,
  resolved_by uuid references public.member(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint file_comment_one_file check (
    (attachment_id is not null and chat_message_id is null and chat_file_path is null)
    or (attachment_id is null and chat_message_id is not null and chat_file_path is not null and char_length(chat_file_path) between 1 and 400)
  ),
  constraint file_comment_place check (
    (page is null and x is null and y is null)
    or (page between 1 and 100000 and x between 0 and 1 and y between 0 and 1)
  ),
  constraint file_comment_body_check check (char_length(body) between 1 and 10000),
  constraint file_comment_mentions_array check (jsonb_typeof(mentions) = 'array')
);

comment on table public.file_comment is
  'A comment on a file, pinned to a place on a page (706): read and written by whoever can read the file; a comment''s words are its author''s.';
comment on column public.file_comment.via_agent is
  'True when the assistant wrote this comment for its author (706, as 692). Set on insert, never changed by a client.';

create index if not exists file_comment_attachment_idx
  on public.file_comment (attachment_id, created_at) where attachment_id is not null;
create index if not exists file_comment_chat_idx
  on public.file_comment (chat_message_id, chat_file_path, created_at) where chat_message_id is not null;
create index if not exists file_comment_parent_idx
  on public.file_comment (parent_id) where parent_id is not null;

-- Can the caller read this comment's file? Under the caller's own row
-- security (not a definer): the file's own rules decide.
create or replace function public.file_comment_file_readable(p_attachment uuid, p_message uuid, p_path text, p_workspace uuid)
returns boolean
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if p_attachment is not null then
    return exists (select 1 from public.attachments a where a.id = p_attachment and a.workspace_id = p_workspace);
  end if;
  return p_message is not null and p_path is not null and exists (
    select 1 from public.team_chat_message m
     where m.id = p_message
       and m.workspace_id = p_workspace
       and m.deleted_at is null
       and exists (select 1 from jsonb_array_elements(m.attachments) f where f ->> 'path' = p_path)
  );
end;
$$;

revoke all on function public.file_comment_file_readable(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.file_comment_file_readable(uuid, uuid, text, uuid) to authenticated, service_role;

-- What a reply may name as its parent: the first comment of a thread on the
-- same file. Definer, so the parent is found whatever its own policies say;
-- the reply's own insert rule still asks that the caller reads the file.
create or replace function public.file_comment_is_thread(p_parent uuid, p_attachment uuid, p_message uuid, p_path text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.file_comment p
     where p.id = p_parent
       and p.parent_id is null
       and p.attachment_id is not distinct from p_attachment
       and p.chat_message_id is not distinct from p_message
       and p.chat_file_path is not distinct from p_path
  );
$$;

revoke all on function public.file_comment_is_thread(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.file_comment_is_thread(uuid, uuid, uuid, text) to authenticated, service_role;

-- 682's and 681's rule for a client's update.
create or replace function public.file_comment_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_me uuid;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.workspace_id is distinct from old.workspace_id
     or new.attachment_id is distinct from old.attachment_id
     or new.chat_message_id is distinct from old.chat_message_id
     or new.chat_file_path is distinct from old.chat_file_path
     or new.author_id is distinct from old.author_id
     or new.parent_id is distinct from old.parent_id
     or new.page is distinct from old.page
     or new.x is distinct from old.x
     or new.y is distinct from old.y
     or new.created_at is distinct from old.created_at then
    raise exception 'A comment keeps its file, its author, its thread, its place and its time.' using errcode = '42501';
  end if;
  v_me := public.current_member_id(old.workspace_id);
  if (new.body is distinct from old.body or new.mentions is distinct from old.mentions)
     and (v_me is null or old.author_id is distinct from v_me) then
    raise exception 'Only its author changes a comment.' using errcode = '42501';
  end if;
  if new.resolved_by is distinct from old.resolved_by
     and new.resolved_by is not null
     and (v_me is null or new.resolved_by is distinct from v_me) then
    raise exception 'A thread is resolved as oneself.' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.file_comment_guard() is
  'What a client update may change in a file comment (706): never its file, author, thread, place or time; its words only by its author; a resolver is recorded as themself.';

drop trigger if exists file_comment_guard on public.file_comment;
create trigger file_comment_guard
  before update on public.file_comment
  for each row execute function public.file_comment_guard();

-- 692's guard, as on canvas and spreadsheet comments.
drop trigger if exists file_comment_agent_mark_guard on public.file_comment;
create trigger file_comment_agent_mark_guard
  before update on public.file_comment
  for each row execute function public.record_comment_agent_mark_guard();

alter table public.file_comment enable row level security;

drop policy if exists file_comment_select on public.file_comment;
create policy file_comment_select on public.file_comment
  for select to authenticated
  using (public.file_comment_file_readable(attachment_id, chat_message_id, chat_file_path, workspace_id));

drop policy if exists file_comment_insert on public.file_comment;
create policy file_comment_insert on public.file_comment
  for insert to authenticated
  with check (
    author_id is not null
    and author_id = public.current_member_id(workspace_id)
    and not via_agent
    and resolved_at is null
    and resolved_by is null
    and public.file_comment_file_readable(attachment_id, chat_message_id, chat_file_path, workspace_id)
    and (
      parent_id is null
      or public.file_comment_is_thread(parent_id, attachment_id, chat_message_id, chat_file_path)
    )
  );

drop policy if exists file_comment_update on public.file_comment;
create policy file_comment_update on public.file_comment
  for update to authenticated
  using (public.file_comment_file_readable(attachment_id, chat_message_id, chat_file_path, workspace_id))
  with check (public.file_comment_file_readable(attachment_id, chat_message_id, chat_file_path, workspace_id));

drop policy if exists file_comment_delete on public.file_comment;
create policy file_comment_delete on public.file_comment
  for delete to authenticated
  using (
    author_id is not null
    and author_id = public.current_member_id(workspace_id)
    and public.file_comment_file_readable(attachment_id, chat_message_id, chat_file_path, workspace_id)
  );

revoke all on table public.file_comment from anon, authenticated;
grant select, insert, update, delete on table public.file_comment to authenticated;
grant all on table public.file_comment to service_role;

-- 688's list, with 'attachment'.
alter table public.notification drop constraint if exists notification_target_type_check;
alter table public.notification add constraint notification_target_type_check check (target_type in (
  'action', 'capture', 'document', 'project', 'contact', 'company',
  'cycle', 'comment', 'decision', 'share', 'flow_run', 'flow', 'agent_run',
  'initiative',
  'work_item', 'email_draft', 'sequence',
  'team_chat_message', 'team_chat_channel',
  'canvas', 'spreadsheet',
  'attachment'
)) not valid;
alter table public.notification validate constraint notification_target_type_check;

notify pgrst, 'reload schema';

commit;
