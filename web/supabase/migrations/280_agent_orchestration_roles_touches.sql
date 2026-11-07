-- Migration 280: agent orchestration, Sequence step 2 — B PR 1 + work_touch
-- (docs/plans/agent-orchestration-product.md Part 5 row 2; the follow-up's
-- §B.2/§B.4 PR 1 and §C.1). Schema and vocabulary only: NOTHING reads the new
-- columns yet, every default reproduces today's behaviour, and no row changes
-- meaning. History starts accumulating in `work_touch` from the writers that
-- ship with this migration (the four internal tool routes, the recorder's
-- finish, verdict-apply, the extraction flush).
--
-- What lands, table by table:
--   ai_team_member  role, autonomy, allowed_side_effects, tool_allowlist,
--                   can_delegate_to, is_system (+ a delete guard for system rows,
--                   and system rows readable across private teams)
--   agent_run       origin, origin_depth, parent_run_id, root_run_id
--   tracked_job     ai_team_member_id, origin, parent_id, root_id, depth;
--                   member_id NULLABLE under CHECK (member_id OR ai_team_member_id);
--                   status gains 'waiting_on_child'
--   attention_item  entity_type, entity_id, capture_id (+ backfill of pending rows
--                   from payload)
--   proposed_change indexes on entity_id / result_entity_id
--   work_touch      the entity ↔ run relation (member SELECT RLS, no client writes)
--
-- NOT in this migration, deliberately: the tracked_job SELECT widening to
-- workspace members (plan 1.3). It changes what every member sees in Activity
-- today, and step 2 is "nothing user-visible"; it rides with the surface PRs
-- (steps 4/7). Until then a run with no human owner is a row nobody selects,
-- which is fine because nothing writes one yet.
--
-- Idempotent throughout (ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS +
-- re-ADD, CREATE INDEX IF NOT EXISTS, guarded publication add).

-- ── The closed vocabularies (one place; the app mirrors them in
--    src/lib/work/roles.ts and src/lib/ai/tool-registry.ts) ─────────────────
--   roles:        researcher | writer | developer | correspondent
--   autonomy:     off | propose | attempt   (per teammate; the workspace policy
--                 lives on workspace.settings.agent_autonomy)
--   side effects: read | internal-write | external-write | automation-write | delete
--   origins:      user | loop | attempt | delegation

-- ═══════════════════════════════════════════════════════════════════════════
-- ai_team_member — who a teammate is for, how far it may go on its own
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.ai_team_member
  add column if not exists role text null,
  add column if not exists autonomy text not null default 'propose',
  add column if not exists allowed_side_effects text[] not null default '{read}',
  add column if not exists tool_allowlist text[] null,
  add column if not exists can_delegate_to text[] not null default '{}',
  add column if not exists is_system boolean not null default false;

comment on column public.ai_team_member.role is
  'Routing role (researcher | writer | developer | correspondent). NULL = not routable: an attempted run is never assigned to it.';
comment on column public.ai_team_member.autonomy is
  'Per-teammate switch under the workspace policy: off | propose | attempt. attempt only counts when workspace.settings.agent_autonomy.mode is attempt too.';
comment on column public.ai_team_member.allowed_side_effects is
  'The tool CLASSES this teammate may call on an unattended run (⊆ the five registry classes). Default {read}: a teammate that was never configured can only look.';
comment on column public.ai_team_member.tool_allowlist is
  'Optional per-tool narrowing inside the allowed classes (bare registry tool names). NULL = every tool of the allowed classes.';
comment on column public.ai_team_member.can_delegate_to is
  'Roles this teammate may hand work to via delegate_work (the launch matrix, as data). Empty = may not delegate.';
comment on column public.ai_team_member.is_system is
  'A seeded teammate for a built-in loop (Triage, Extraction, …): readable across private teams, never deletable from the app.';

alter table public.ai_team_member drop constraint if exists ai_team_member_role_check;
alter table public.ai_team_member add constraint ai_team_member_role_check
  check (role is null or role in ('researcher', 'writer', 'developer', 'correspondent'));

alter table public.ai_team_member drop constraint if exists ai_team_member_autonomy_check;
alter table public.ai_team_member add constraint ai_team_member_autonomy_check
  check (autonomy in ('off', 'propose', 'attempt'));

alter table public.ai_team_member drop constraint if exists ai_team_member_allowed_side_effects_check;
alter table public.ai_team_member add constraint ai_team_member_allowed_side_effects_check
  check (allowed_side_effects <@ array['read', 'internal-write', 'external-write', 'automation-write', 'delete']::text[]);

alter table public.ai_team_member drop constraint if exists ai_team_member_can_delegate_to_check;
alter table public.ai_team_member add constraint ai_team_member_can_delegate_to_check
  check (can_delegate_to <@ array['researcher', 'writer', 'developer', 'correspondent']::text[]);

-- The gate's lookup: "the workspace's teammate for this role".
create index if not exists ai_team_member_workspace_role_idx
  on public.ai_team_member (workspace_id, role)
  where role is not null;

-- System teammates are readable by every workspace member, private team or
-- not (plan 1.4): the roster shows every agent. Everything else about the
-- SELECT policy is unchanged (mig 144:57).
drop policy if exists "Workspace members can view AI team members" on public.ai_team_member;
create policy "Workspace members can view AI team members" on public.ai_team_member
  for select using (
    public.is_workspace_member(workspace_id)
    and (
      is_system
      or exists (
        select 1 from public.team t
        where t.id = ai_team_member.team_id
          and (not t.is_private or public.is_team_member(t.id))
      )
    )
  );

-- A system teammate is not deletable from the app. A trigger rather than a
-- policy clause so admins keep the UPDATE path (autonomy, role) and only the
-- DELETE is refused; a migration that must remove one disables the trigger.
create or replace function public.ai_team_member_protect_system()
returns trigger
language plpgsql
as $$
begin
  if old.is_system then
    raise exception 'system teammates cannot be deleted (ai_team_member %)', old.id
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists ai_team_member_protect_system on public.ai_team_member;
create trigger ai_team_member_protect_system
  before delete on public.ai_team_member
  for each row execute function public.ai_team_member_protect_system();

-- ═══════════════════════════════════════════════════════════════════════════
-- agent_run — where a run came from and how deep it sits
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.agent_run
  add column if not exists origin text not null default 'user',
  add column if not exists origin_depth integer not null default 0,
  add column if not exists parent_run_id uuid null references public.agent_run(id) on delete set null,
  add column if not exists root_run_id uuid null references public.agent_run(id) on delete set null;

comment on column public.agent_run.origin is
  'user (a person pressed Start) | loop (a flow''s run_agent action) | attempt (the auto-attempt gate, B PR 3) | delegation (delegate_work). Every existing row is user.';
comment on column public.agent_run.origin_depth is
  'Chain depth: 0 for a run a person or loop started; a delegated child is parent + 1. The policy''s max_delegation_depth is enforced against it.';
comment on column public.agent_run.parent_run_id is 'The delegating run, for a delegated child.';
comment on column public.agent_run.root_run_id is 'The top of the delegation chain (the run whose budget the whole subtree spends).';

alter table public.agent_run drop constraint if exists agent_run_origin_check;
alter table public.agent_run add constraint agent_run_origin_check
  check (origin in ('user', 'loop', 'attempt', 'delegation'));

alter table public.agent_run drop constraint if exists agent_run_origin_depth_check;
alter table public.agent_run add constraint agent_run_origin_depth_check
  check (origin_depth >= 0);

-- The budgets count attempted runs per workspace per day; the kill switch
-- sweeps in-flight runs by origin (cancel-workspace-runs.ts `origins`).
create index if not exists agent_run_workspace_origin_created_idx
  on public.agent_run (workspace_id, origin, created_at desc);
create index if not exists agent_run_parent_idx
  on public.agent_run (parent_run_id)
  where parent_run_id is not null;
create index if not exists agent_run_root_idx
  on public.agent_run (root_run_id)
  where root_run_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- tracked_job — which agent, which parent, and a row with no human owner
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.tracked_job
  add column if not exists ai_team_member_id uuid null references public.ai_team_member(id) on delete set null,
  add column if not exists origin text not null default 'user',
  add column if not exists parent_id uuid null references public.tracked_job(id) on delete set null,
  add column if not exists root_id uuid null references public.tracked_job(id) on delete set null,
  add column if not exists depth integer not null default 0;

comment on column public.tracked_job.ai_team_member_id is
  'The teammate that did (or is doing) the work — the "which agent" every ledger row needs. NULL until the writers stamp it (steps 4 and 8).';
comment on column public.tracked_job.origin is 'Same vocabulary as agent_run.origin; every existing row is user.';
comment on column public.tracked_job.parent_id is 'The delegating work item, for a delegated child (nesting on the surface).';
comment on column public.tracked_job.root_id is 'The top of the delegation chain.';
comment on column public.tracked_job.depth is 'Chain depth, 0 for a root.';

alter table public.tracked_job drop constraint if exists tracked_job_origin_check;
alter table public.tracked_job add constraint tracked_job_origin_check
  check (origin in ('user', 'loop', 'attempt', 'delegation'));

alter table public.tracked_job drop constraint if exists tracked_job_depth_check;
alter table public.tracked_job add constraint tracked_job_depth_check
  check (depth >= 0);

-- A run with no human at all (a cron sweep, a system-lane job) could not be a
-- ledger row: member_id was a NOT NULL FK to a human member (170:26). It is now
-- nullable, but a row must still name SOMEONE — a human or a teammate.
alter table public.tracked_job alter column member_id drop not null;
alter table public.tracked_job drop constraint if exists tracked_job_has_owner;
alter table public.tracked_job add constraint tracked_job_has_owner
  check (member_id is not null or ai_team_member_id is not null);

-- "Waiting on a child": a parent parked while a delegated child runs. Not a
-- human's turn (so not needs_input) and not finished. Nothing writes it until
-- delegate_work lands (step 13); the vocabulary is here so the app and the
-- database agree from the first row.
alter table public.tracked_job drop constraint if exists tracked_job_status_check;
alter table public.tracked_job add constraint tracked_job_status_check
  check (status in ('queued', 'running', 'needs_input', 'needs_review', 'waiting_on_child', 'done', 'failed', 'skipped', 'canceled'));

create index if not exists tracked_job_workspace_ai_member_created_idx
  on public.tracked_job (workspace_id, ai_team_member_id, created_at desc)
  where ai_team_member_id is not null;
create index if not exists tracked_job_parent_idx
  on public.tracked_job (parent_id)
  where parent_id is not null;
create index if not exists tracked_job_root_idx
  on public.tracked_job (root_id)
  where root_id is not null;

-- The deadline index must keep covering the new open state for the reaper.
drop index if exists public.tracked_job_deadline_idx;
create index if not exists tracked_job_deadline_idx
  on public.tracked_job (deadline_at)
  where status in ('queued', 'running', 'waiting_on_child');

-- ═══════════════════════════════════════════════════════════════════════════
-- attention_item — which entity a card is about (plan 2.2)
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.attention_item
  add column if not exists entity_type text null,
  add column if not exists entity_id uuid null,
  add column if not exists capture_id uuid null references public.captures(id) on delete set null;

comment on column public.attention_item.entity_type is
  'The entity the card is about (an entity-registry kind), when it is about one; a work_proposal without an id-bearing resource legitimately has none.';
comment on column public.attention_item.entity_id is 'The entity''s id; pairs with entity_type.';
comment on column public.attention_item.capture_id is 'The capture the card came from, when it came from one.';

create index if not exists attention_item_workspace_entity_pending_idx
  on public.attention_item (workspace_id, entity_id)
  where status = 'pending' and entity_id is not null;
create index if not exists attention_item_capture_pending_idx
  on public.attention_item (capture_id)
  where status = 'pending' and capture_id is not null;

-- Backfill pending cards from what the payload already carries. Only values
-- that parse as uuids are copied; anything else stays NULL. The insert path
-- (verdict-apply insertAttentionCard) stamps the columns from now on.
update public.attention_item
set capture_id = (payload ->> 'capture_id')::uuid
where capture_id is null
  and status = 'pending'
  and payload ->> 'capture_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Proposal-backed cards: the proposal's own entity, when the payload names it.
update public.attention_item
set entity_type = payload ->> 'entity_type',
    entity_id = (payload ->> 'entity_id')::uuid
where entity_id is null
  and status = 'pending'
  and payload ->> 'entity_type' is not null
  and payload ->> 'entity_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- work_proposal cards: the first declared resource that carries an id.
update public.attention_item a
set entity_type = r.type,
    entity_id = r.id::uuid
from (
  select i.id as card_id,
         (res ->> 'type') as type,
         (res ->> 'id') as id,
         row_number() over (partition by i.id order by ord) as rn
  from public.attention_item i
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(i.payload -> 'resources') = 'array' then i.payload -> 'resources' else '[]'::jsonb end
  ) with ordinality as e(res, ord)
  where i.kind = 'work_proposal'
    and i.status = 'pending'
    and i.entity_id is null
    and (res ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (res ->> 'type') is not null
    and (res ->> 'type') <> 'package'
) r
where r.card_id = a.id and r.rn = 1;

-- ═══════════════════════════════════════════════════════════════════════════
-- proposed_change — the two entity columns the entity tab and age-out scan
-- ═══════════════════════════════════════════════════════════════════════════

create index if not exists proposed_change_entity_idx
  on public.proposed_change (entity_id)
  where entity_id is not null;
create index if not exists proposed_change_result_entity_idx
  on public.proposed_change (result_entity_id)
  where result_entity_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- work_touch — every entity a unit of work touched (follow-up §C.1)
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per touch. `read` rows come from the internal tool routes (the only
-- place a run's reads are visible); `wrote`/`created`/`proposed` from the tool
-- routes, verdict-apply and the extraction flush; `delivered` from the
-- recorder's finish. Repeated touches are repeated rows (this is a log, not a
-- link table). Written by the service role only; workspace members read.

create table if not exists public.work_touch (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  work_item_id uuid not null references public.tracked_job(id) on delete cascade,
  agent_run_id uuid null references public.agent_run(id) on delete set null,
  entity_type text not null,
  entity_id uuid not null,
  verb text not null,
  tool_name text null,
  at timestamptz not null default now(),
  constraint work_touch_verb_check check (verb in ('read', 'wrote', 'created', 'proposed', 'delivered'))
);

comment on table public.work_touch is
  'The entity ↔ run relation: which entities a unit of work (tracked_job) read, wrote, created, proposed or delivered, and with which tool. Service-role writes only.';
comment on column public.work_touch.entity_type is
  'An entity-registry kind (action, capture, project, contact, company, document, …) or proposal | email_draft | pr.';
comment on column public.work_touch.tool_name is
  'The bare tool name that made the touch; declared for a run''s declared resources; backfill for rows the one-shot script recovered.';

-- The entity tab: everything that touched this entity, newest first.
create index if not exists work_touch_entity_idx
  on public.work_touch (workspace_id, entity_type, entity_id, at desc);
-- The work-item panel: everything this run touched, in order.
create index if not exists work_touch_work_item_idx
  on public.work_touch (work_item_id, at);
create index if not exists work_touch_agent_run_idx
  on public.work_touch (agent_run_id)
  where agent_run_id is not null;
-- The one-shot backfill is idempotent on this key; live writes never use the
-- 'backfill' tool_name, so repeated live touches stay recordable.
create unique index if not exists work_touch_backfill_uidx
  on public.work_touch (work_item_id, entity_type, entity_id, verb)
  where tool_name in ('backfill', 'declared');

alter table public.work_touch enable row level security;

drop policy if exists work_touch_member_select on public.work_touch;
create policy work_touch_member_select on public.work_touch
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
-- No INSERT / UPDATE / DELETE policy: clients cannot write an audit row.

-- Realtime for the entity tab (step 10): a row-level channel filtered on the
-- entity column. REPLICA IDENTITY FULL so a delete/update payload carries the
-- columns the filter needs (same as tracked_job, 272:111).
alter table public.work_touch replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.work_touch;
exception
  when duplicate_object then null;
end $$;
