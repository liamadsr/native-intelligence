-- ============================================================
-- 569: Call audio's retention (calls plan, phase 6): the files in the
-- team-call-recordings bucket whose call is gone.
-- ============================================================
--   team_call_recordings_orphans(max_rows)  service role: the names of
--                     objects in the bucket whose call row no longer exists
--                     (a deleted channel takes its calls' rows with it, the
--                     files stay), or that are not named for a call at all,
--                     oldest first, at most max_rows (1 to 1000). The daily
--                     retention (src/lib/team-calls/notes-retention.ts)
--                     removes them through the storage API.
--
-- Additive: one new function. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

create or replace function public.team_call_recordings_orphans(max_rows integer)
returns table (name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'team-call-recordings'
     and not exists (
       select 1 from public.team_call t
        where t.id = case
          when split_part(o.name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then split_part(o.name, '/', 2)::uuid
        end
     )
   order by o.created_at
   limit greatest(1, least(coalesce(max_rows, 200), 1000));
$$;

revoke all on function public.team_call_recordings_orphans(integer) from public, anon, authenticated;
grant execute on function public.team_call_recordings_orphans(integer) to service_role;

notify pgrst, 'reload schema';

commit;
