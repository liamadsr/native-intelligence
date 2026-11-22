-- ============================================================
-- 691: a project's priority.
-- ============================================================
-- Why: the project update route has written projects.priority for a long
-- time, and DEV has the column (text, commented "none, low, medium, high,
-- urgent"), but no migration in this repository adds it, so a database built
-- from the migrations alone may lack it, and nothing holds what it may say.
-- The Create composer now sets it, and the project card shows and sets it
-- (docs/plans/create-everything.md, "Decisions to review", 6).
--
-- What lands:
--   projects.priority   text, nullable (null: none set). Added only where it
--                       is missing; where it exists it is left as it is.
--   projects_priority_check
--                       the actions' own five values (action_priority, 022):
--                       'none', 'low', 'medium', 'high', 'urgent', or null.
--                       The app sends null for none, but 'none' is allowed
--                       so a row an older build wrote stays valid.
--
-- A value already stored that the check would refuse is first put right: the
-- same word in another case or with spaces around it becomes that word, and
-- anything else becomes null (no screen showed it as a priority).
--
-- Nothing else changes: no policy, trigger or function is touched. The update
-- policy (projects_update) already decides who may change a project; this
-- only bounds what the column may hold. A client cannot reach any other row
-- or column through it.
--
-- Re-runnable. Its own transaction (begin ... commit), so it is all or
-- nothing however it is applied, with or without --single-transaction. No
-- backslashes anywhere in this file.
-- ============================================================

begin;

SET LOCAL lock_timeout = '5s';

alter table public.projects add column if not exists priority text;

comment on column public.projects.priority is
  'Priority level: none, low, medium, high, urgent (migration 691), or null for none set';

update public.projects
   set priority = case
         when lower(btrim(priority)) in ('none', 'low', 'medium', 'high', 'urgent') then lower(btrim(priority))
         else null
       end
 where priority is not null
   and priority not in ('none', 'low', 'medium', 'high', 'urgent');

alter table public.projects drop constraint if exists projects_priority_check;
alter table public.projects
  add constraint projects_priority_check
  check (priority is null or priority in ('none', 'low', 'medium', 'high', 'urgent'));

commit;
