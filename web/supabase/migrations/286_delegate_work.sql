-- 286: delegate_work — one work run hands a piece of its work to a teammate
-- (docs/plans/agent-orchestration-product.md, Part 3; Part 5 row 13).
--
-- 1. agent_run.expects — what a work run must hand back, as
--    [{ type, min?, entity_type? }] (src/lib/work/roles.ts WorkExpectation).
--    A delegated child carries its parent's expectation; an attempt carries its
--    card's. The outcome route checks the deliverables against it at settle and
--    never fails the run for it: an honest short result is reviewable, not
--    broken. NULL for every existing run and for a person's Start.
--
-- 2. agent_run_has_origin (mig 158) required an action or a flow on every run.
--    A delegated child has neither of its own: its origin is its parent run
--    (parent_run_id, mig 280). Copying the parent's action_id instead would let
--    the child's settle complete the parent's tracked action.
--
-- 3. can_delegate_to (mig 280) was empty on every teammate and nothing wrote
--    it, so every handoff would be refused. The launch matrix: the Writer, the
--    Correspondent and the Developer may hand research to the Researcher; the
--    Researcher hands off to nobody. Only teammates still on the empty default
--    are set; seed_role_teammates seeds new ones the same way.

alter table public.agent_run add column if not exists expects jsonb;

alter table public.agent_run drop constraint if exists agent_run_expects_is_array;
alter table public.agent_run
  add constraint agent_run_expects_is_array
  check (expects is null or jsonb_typeof(expects) = 'array');

alter table public.agent_run drop constraint if exists agent_run_has_origin;
alter table public.agent_run
  add constraint agent_run_has_origin
  check (action_id is not null or flow_id is not null or parent_run_id is not null);

update public.ai_team_member
set can_delegate_to = array['researcher']
where role in ('writer', 'correspondent', 'developer')
  and can_delegate_to = '{}'::text[];

-- seed_role_teammates (mig 284), unchanged except that each role teammate is
-- seeded with its launch can_delegate_to.
create or replace function public.seed_role_teammates(p_workspace_id uuid, p_created_by uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team uuid;
  v_by uuid;
  v_recipe uuid;
  v_count integer := 0;
  s record;
begin
  perform pg_advisory_xact_lock(hashtext('seed_role_teammates:' || p_workspace_id::text));

  select t.id into v_team
  from public.team t
  where t.workspace_id = p_workspace_id
  order by t.is_private asc, t.created_at asc, t.id asc
  limit 1;
  if v_team is null then
    return 0;
  end if;

  -- Who the rows are "created by": the person who flipped the switch, else the
  -- workspace's first owner.
  v_by := p_created_by;
  if v_by is null then
    select m.user_id into v_by
    from public.member m
    where m.workspace_id = p_workspace_id and m.role = 'owner'
    order by m.created_at asc
    limit 1;
  end if;

  for s in
    select * from (values
      (
        1, 'researcher', 'Researcher', 'role-researcher', '🔎', '#0ea5e9',
        'Finds out what is true and writes it down, with sources.',
        'You are the workspace''s Researcher. You find out what is actually true and write it down so a person can act on it. Prefer primary sources over summaries of them, cite the URL of every fact you take from the web, and keep what you found separate from what you infer. When you could not establish something, say so plainly instead of guessing. Deliver a document: the answer first, in a few sentences, then the evidence behind it.',
        'attempt', array['read', 'internal-write'], array[]::text[]
      ),
      (
        2, 'writer', 'Writer', 'role-writer', '✍️', '#3b82f6',
        'Drafts documents people can use as they are.',
        'You are the workspace''s Writer. You draft documents people can use with light edits: lead with the point, match the workspace''s tone, and keep it as short as the job allows. Every specific (a name, a date, a number, a commitment) comes from the workspace or the brief; never invent one, and mark anything you had to assume.',
        'attempt', array['read', 'internal-write'], array['researcher']
      ),
      (
        3, 'correspondent', 'Correspondent', 'role-correspondent', '✉️', '#10b981',
        'Drafts emails for a person to review and send.',
        'You are the workspace''s Correspondent. You draft emails for a person to review and send; you never send one yourself. Open with what the recipient needs to know, make one clear ask, and keep paragraphs short. Promise nothing the workspace has not agreed to, and ground every name, date and figure in the workspace or the brief.',
        'attempt', array['read', 'internal-write'], array['researcher']
      ),
      (
        4, 'developer', 'Developer', 'role-developer', '🛠️', '#6366f1',
        'Scopes code changes into a plan an engineer or a coding run can pick up.',
        'You are the workspace''s Developer. You turn a request into a change someone can build: read the linked project, action and discussion, then write down what should change, the files and systems likely involved, how to verify it, and the risks. Be concrete and brief, and say what you could not confirm from the workspace.',
        'propose', array['read'], array['researcher']
      )
    ) as v(ord, role, name, slug, icon, color, description, prompt, autonomy, classes, delegates)
    order by ord
  loop
    if exists (
      select 1 from public.ai_team_member a
      where a.workspace_id = p_workspace_id and a.role = s.role
    ) then
      continue;
    end if;

    select r.id into v_recipe
    from public.recipe r
    where r.workspace_id = p_workspace_id and r.slug = s.slug
    limit 1;
    if v_recipe is null then
      insert into public.recipe (
        workspace_id, name, slug, icon, color, description, system_prompt,
        category, is_system, visibility, created_by
      )
      values (
        p_workspace_id, s.name, s.slug, s.icon, s.color, s.description, s.prompt,
        'agent', false, 'workspace', v_by
      )
      returning id into v_recipe;
    end if;

    insert into public.ai_team_member (
      workspace_id, team_id, name, agent_recipe_id, role, autonomy, allowed_side_effects, can_delegate_to, created_by
    )
    values (
      p_workspace_id, v_team, s.name, v_recipe, s.role, s.autonomy, s.classes, s.delegates, v_by
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.seed_role_teammates(uuid, uuid) from public, anon, authenticated;
grant execute on function public.seed_role_teammates(uuid, uuid) to service_role;
