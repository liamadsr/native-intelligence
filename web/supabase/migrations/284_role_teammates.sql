-- 284: role teammates — the Researcher, Writer, Correspondent and Developer a
-- workspace's work routes to (docs/plans/agent-orchestration-product.md, Part 5
-- row 9; follow-up plan §B.4 PR 5 "seed one default teammate per role").
--
-- NOT seeded into every workspace (owner decision). Two callers only:
--   1. the settings write (PATCH /api/account/workspace/agent-autonomy), when a
--      workspace's agent_autonomy.mode flips to 'attempt';
--   2. the calls at the bottom of this file, for the two workspaces the owner
--      named (Dial8 and a customer's), which this file also switches to 'attempt'.
--
-- What a seed creates, per role that NO teammate in the workspace holds yet:
--   - a persona: an agent recipe owned by the workspace (visibility
--     'workspace', slug 'role-<role>'), so it shows in the workspace's Personas
--     library and the workspace can edit its prompt. A later seed reuses it (an
--     admin who deleted the teammate and flips again gets the same persona back,
--     with any edits);
--   - a teammate bound to it, holding the role, on the workspace's oldest PUBLIC
--     team (the oldest team when every team is private). A person's Start routes
--     on the session client, and RLS hides a private team's teammates from
--     everyone outside that team, so a public team keeps the role routable for
--     the whole workspace. (System teammates use the oldest team, private or
--     not: they are visible across private teams by their own policy, mig 280.)
--
-- Autonomy: the three roles an attempt can serve (researcher, writer,
-- correspondent; ATTEMPTABLE_ROLES in src/lib/work/auto-attempt.ts) start at
-- 'attempt' with {read, internal-write}, so a workspace that switches to attempt
-- is attempting with them. Developer starts at 'propose' with {read}: a
-- developer's PR needs a coding run, which the attempt gate does not start. The
-- workspace mode stays the switch above them all; the env switch
-- AGENT_AUTO_ATTEMPT_ENABLED stays above that. tool_allowlist is NULL (every
-- tool of the allowed classes).
--
-- A role any teammate already holds is left alone, whatever its autonomy: that
-- teammate is the role's default (the oldest holder; role-routing.ts).
--
-- Idempotent, and serialised per workspace by an advisory lock, so two
-- concurrent flips cannot both insert. Returns how many teammates it inserted.
-- Service role only (SECURITY DEFINER bypasses RLS; an open RPC would let any
-- signed-in user write teammates into a workspace they are not in).

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
        'attempt', array['read', 'internal-write']
      ),
      (
        2, 'writer', 'Writer', 'role-writer', '✍️', '#3b82f6',
        'Drafts documents people can use as they are.',
        'You are the workspace''s Writer. You draft documents people can use with light edits: lead with the point, match the workspace''s tone, and keep it as short as the job allows. Every specific (a name, a date, a number, a commitment) comes from the workspace or the brief; never invent one, and mark anything you had to assume.',
        'attempt', array['read', 'internal-write']
      ),
      (
        3, 'correspondent', 'Correspondent', 'role-correspondent', '✉️', '#10b981',
        'Drafts emails for a person to review and send.',
        'You are the workspace''s Correspondent. You draft emails for a person to review and send; you never send one yourself. Open with what the recipient needs to know, make one clear ask, and keep paragraphs short. Promise nothing the workspace has not agreed to, and ground every name, date and figure in the workspace or the brief.',
        'attempt', array['read', 'internal-write']
      ),
      (
        4, 'developer', 'Developer', 'role-developer', '🛠️', '#6366f1',
        'Scopes code changes into a plan an engineer or a coding run can pick up.',
        'You are the workspace''s Developer. You turn a request into a change someone can build: read the linked project, action and discussion, then write down what should change, the files and systems likely involved, how to verify it, and the risks. Be concrete and brief, and say what you could not confirm from the workspace.',
        'propose', array['read']
      )
    ) as v(ord, role, name, slug, icon, color, description, prompt, autonomy, classes)
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
      workspace_id, team_id, name, agent_recipe_id, role, autonomy, allowed_side_effects, created_by
    )
    values (
      p_workspace_id, v_team, s.name, v_recipe, s.role, s.autonomy, s.classes, v_by
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.seed_role_teammates(uuid, uuid) from public, anon, authenticated;
grant execute on function public.seed_role_teammates(uuid, uuid) to service_role;

-- The two workspaces the owner named, by the owner's decision: Dial8
-- (62b69210-eef2-40ca-9b02-4afafcb415c8) and a customer's
-- (f67f9293-345c-4def-857d-d1a1854f1723), both prod. Each gets its role
-- teammates, then its agent_autonomy.mode set to 'attempt' — the same two
-- writes the settings page makes when an admin flips a workspace to Attempt.
-- Every other key of settings, and of agent_autonomy, is kept.
--
-- Still inert: nothing attempts while the env switch AGENT_AUTO_ATTEMPT_ENABLED
-- is not exactly 'true' (auto-attempt.ts checks it first, before any read).
-- Where these workspaces do not exist (dev, local, a fresh database) both
-- statements touch nothing.
select public.seed_role_teammates(w.id)
from public.workspace w
where w.id in ('62b69210-eef2-40ca-9b02-4afafcb415c8', 'f67f9293-345c-4def-857d-d1a1854f1723');

update public.workspace w
set settings = jsonb_set(
  coalesce(w.settings, '{}'::jsonb),
  '{agent_autonomy}',
  case
    when jsonb_typeof(w.settings -> 'agent_autonomy') = 'object' then w.settings -> 'agent_autonomy'
    else '{}'::jsonb
  end || '{"mode": "attempt"}'::jsonb
)
where w.id in ('62b69210-eef2-40ca-9b02-4afafcb415c8', 'f67f9293-345c-4def-857d-d1a1854f1723');
