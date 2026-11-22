-- ============================================================
-- 692: a comment the assistant wrote for someone says so.
-- ============================================================
-- An agent can now comment on a canvas (682) and on a spreadsheet (675). It
-- writes through the person's own session, so the comment is that person's
-- (author_id, and every policy and guard of 675, 681 and 682 applies to it
-- as to any comment of theirs). This adds the one thing that tells the two
-- apart: via_agent, true when the assistant wrote the words for them.
--
--   - canvas_comment.via_agent and spreadsheet_comment.via_agent: not null,
--     false for every comment that exists and for every comment a person
--     writes.
--   - record_comment_agent_mark_guard(): a client update never changes the
--     mark. Without it the author could wipe "written by the assistant" off
--     a comment with an edit, or a reader, who may update a row to resolve
--     it, could put it on someone else's. Its own trigger on each table,
--     beside canvas_comment_guard (682) and spreadsheet_comment_guard (675),
--     which are not redefined.
--
-- On insert the mark is whatever the writer says, like the words: a person
-- can only write as themself (the insert policies), so the most they can do
-- is mark their own comment.
--
-- Redefines nothing. Has its own begin/commit. Idempotent: safe to run
-- twice. No backslashes.
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

alter table public.canvas_comment add column if not exists via_agent boolean not null default false;
alter table public.spreadsheet_comment add column if not exists via_agent boolean not null default false;

comment on column public.canvas_comment.via_agent is
  'True when the assistant wrote this comment for its author (692). Set on insert, never changed by a client.';
comment on column public.spreadsheet_comment.via_agent is
  'True when the assistant wrote this comment for its author (692). Set on insert, never changed by a client.';

create or replace function public.record_comment_agent_mark_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.via_agent is distinct from old.via_agent then
    raise exception 'Who wrote a comment does not change.' using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.record_comment_agent_mark_guard() is
  'A client update never changes whether the assistant wrote a canvas or spreadsheet comment (692).';

drop trigger if exists canvas_comment_agent_mark_guard on public.canvas_comment;
create trigger canvas_comment_agent_mark_guard
  before update on public.canvas_comment
  for each row execute function public.record_comment_agent_mark_guard();

drop trigger if exists spreadsheet_comment_agent_mark_guard on public.spreadsheet_comment;
create trigger spreadsheet_comment_agent_mark_guard
  before update on public.spreadsheet_comment
  for each row execute function public.record_comment_agent_mark_guard();

commit;

notify pgrst, 'reload schema';
