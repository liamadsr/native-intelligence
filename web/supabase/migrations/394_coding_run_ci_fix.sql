-- Migration 394: the CI fix loop on Dial8's own pull requests
-- (eve-templates-lessons.md F7; P10).
--
-- Opt-in: only for a person who switched on the ci_fix_loop recipe for the
-- repo (a loop, never a setting or a default). Then a failing check on a
-- branch their coding run created (dial8/<identifier>-<run>, with its PR
-- open) starts ONE fix run on that branch, at most two per PR;
-- after that the starter's home thread says "CI is still red on ENG-42" (ci-fix.ts,
-- from the GitHub webhook's check_suite / check_run events).
--
--   ci_fix_of_run_id  on a fix run: the run whose PR it fixes. NULL on every
--                     other run.
--   ci_failure        on a fix run: the failing checks as GitHub reported
--                     them (names, conclusions, their output, bounded). Raw
--                     here; the task fences it as untrusted when it is read.
--   ci_fix_trail      on the run that opened the PR: one entry per failing
--                     head commit it reacted to, in order:
--                       { kind: 'fix', head_sha, fix_run_id, at }
--                       { kind: 'gave_up', head_sha, at }
--                     The count of 'fix' entries is the cap; nothing else
--                     counts, so the run's own trail is its only memory.
--
-- agent_run_claim_ci_fix decides one failing commit atomically (two check
-- events for one commit arrive together): the row is locked, then
--   'duplicate'  this commit was already handled;
--   'busy'       a fix run of this PR is still going: any fix entry whose
--                run is not settled, or whose row is missing (claimed, not yet
--                inserted, or never inserted);
--   'start'      a fix entry is appended (with the fix run's id, inserted
--                next by the caller);
--   'exhausted'  the cap is reached: a gave_up entry is appended, once;
--   'reported'   the cap was reached and already reported;
--   'missing'    no such run in that workspace.
-- Service role only.
--
-- Idempotent: add column if not exists, create index if not exists, create
-- or replace, revoke then grant. Applies before the app code.

SET LOCAL lock_timeout = '5s';

alter table public.agent_run add column if not exists ci_fix_of_run_id uuid null references public.agent_run(id) on delete set null;
alter table public.agent_run add column if not exists ci_failure jsonb;
alter table public.agent_run add column if not exists ci_fix_trail jsonb not null default '[]'::jsonb;

comment on column public.agent_run.ci_fix_of_run_id is
  'On a CI fix run (394, src/lib/coding/ci-fix.ts): the coding run whose open PR it fixes.';
comment on column public.agent_run.ci_failure is
  'On a CI fix run (394): the failing checks as GitHub reported them, bounded. Untrusted text; fenced when read into a task.';
comment on column public.agent_run.ci_fix_trail is
  'On a run that opened a PR (394): each failing head commit it reacted to, fix or gave_up. At most two fix entries.';

-- The webhook finds the run behind a branch by repo and branch.
create index if not exists agent_run_coding_branch_idx
  on public.agent_run (repo_full_name, branch)
  where kind = 'coding' and ci_fix_of_run_id is null;

create index if not exists agent_run_ci_fix_of_idx
  on public.agent_run (ci_fix_of_run_id)
  where ci_fix_of_run_id is not null;

create or replace function public.agent_run_claim_ci_fix(
  p_run_id uuid,
  p_workspace_id uuid,
  p_head_sha text,
  p_fix_run_id uuid,
  p_max integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trail jsonb;
  v_fixes integer;
begin
  select coalesce(ci_fix_trail, '[]'::jsonb) into v_trail
    from public.agent_run
   where id = p_run_id
     and workspace_id = p_workspace_id
     for update;
  if not found then
    return 'missing';
  end if;

  if exists (select 1 from jsonb_array_elements(v_trail) e where e ->> 'head_sha' = p_head_sha) then
    return 'duplicate';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_trail) e
     where e ->> 'kind' = 'fix'
       and not exists (
         select 1 from public.agent_run f
          where f.id::text = e ->> 'fix_run_id'
            and f.status in ('pr_open', 'completed', 'failed', 'canceled')
       )
  ) then
    return 'busy';
  end if;

  select count(*) into v_fixes from jsonb_array_elements(v_trail) e where e ->> 'kind' = 'fix';

  if v_fixes >= p_max then
    if exists (select 1 from jsonb_array_elements(v_trail) e where e ->> 'kind' = 'gave_up') then
      return 'reported';
    end if;
    update public.agent_run
       set ci_fix_trail = v_trail || jsonb_build_array(jsonb_build_object('kind', 'gave_up', 'head_sha', p_head_sha, 'at', now()))
     where id = p_run_id;
    return 'exhausted';
  end if;

  update public.agent_run
     set ci_fix_trail = v_trail || jsonb_build_array(jsonb_build_object('kind', 'fix', 'head_sha', p_head_sha, 'fix_run_id', p_fix_run_id, 'at', now()))
   where id = p_run_id;
  return 'start';
end;
$$;

revoke all on function public.agent_run_claim_ci_fix(uuid, uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.agent_run_claim_ci_fix(uuid, uuid, text, uuid, integer) to service_role;
