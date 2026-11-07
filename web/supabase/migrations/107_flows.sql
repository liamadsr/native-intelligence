-- Migration 105: Flows (Phase 3 v1)
--
-- Flows let users wire workspace events to outbound HTTP calls. A flow has
-- one trigger and one action — single-step, no branching. The shape is
-- intentionally narrow for v1: status-change trigger + HTTP POST action.
-- We store trigger/action config as separate jsonb columns (rather than a
-- nodes/edges graph) because v1 has exactly one trigger node and one action
-- node; when v2 introduces filters/branches/multi-step we'll add a `graph`
-- jsonb column without invalidating these rows.
--
-- Outbound bearer tokens are encrypted at rest with aes-256-gcm via
-- src/lib/crypto/credentials.ts — same pattern as connected_mcp_server.
-- Postgres never sees the plaintext.

-- ──────────────────────────────────────────────────────────────────
-- 1. Enums
-- ──────────────────────────────────────────────────────────────────
-- entity_status_change is generic over the entity whose status changed.
-- v1 only accepts entity_type='action' in trigger_config, but the enum
-- value is entity-agnostic so we don't need a new enum value when v1.1
-- adds project/initiative/milestone wiring.
create type public.flow_trigger_type as enum (
  'entity_status_change'
);

create type public.flow_action_type as enum (
  'http_post'
);

create type public.flow_run_status as enum (
  'pending',
  'success',
  'failed'
);

-- ──────────────────────────────────────────────────────────────────
-- 2. flow table
-- ──────────────────────────────────────────────────────────────────
create table public.flow (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,

  -- Most triggers in v1 are scoped to a team's workflow_state board, so we
  -- keep team_id required. If a future trigger type isn't team-scoped we'll
  -- relax this with a follow-up migration.
  team_id uuid not null references public.team(id) on delete cascade,

  name text not null,
  description text,
  enabled boolean not null default true,

  trigger_type public.flow_trigger_type not null,
  -- For entity_status_change with entity_type='action':
  --   { entity_type: 'action', from_status_id: uuid | null, to_status_id: uuid }
  -- A null from_status_id means "match any source status".
  -- v1.1 will add entity_type values for 'project' | 'initiative' | 'milestone'
  -- whose from/to use string enum values instead of UUIDs.
  trigger_config jsonb not null default '{}'::jsonb,

  action_type public.flow_action_type not null,
  -- For http_post: { method: 'POST', url: string, headers: { [k]: string }, body_template: string }
  action_config jsonb not null default '{}'::jsonb,

  -- aes-256-gcm ciphertext. Never store plaintext bearer tokens.
  bearer_token_encrypted text,

  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_flow_workspace on public.flow(workspace_id);
create index idx_flow_team on public.flow(team_id);
-- The dispatch hot path filters by (team_id, enabled, trigger_type); this
-- partial index keeps the lookup cheap even with many disabled flows.
create index idx_flow_dispatch
  on public.flow(team_id, trigger_type)
  where enabled = true;

-- Touch updated_at on row update.
create or replace function public.touch_flow_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_flow_updated_at
  before update on public.flow
  for each row execute function public.touch_flow_updated_at();

-- ──────────────────────────────────────────────────────────────────
-- 3. flow_run table — execution history
-- ──────────────────────────────────────────────────────────────────
create table public.flow_run (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flow(id) on delete cascade,

  -- The action that caused the trigger to fire. Nullable because a manual
  -- test-fire from the UI has no real triggering action.
  triggered_by_action_id uuid references public.actions(id) on delete set null,

  status public.flow_run_status not null default 'pending',

  -- A small snapshot of what we sent (url, method, header keys without
  -- values, rendered body length) so the user can debug without exposing
  -- the bearer token or full payload to anyone viewing the run history.
  request_summary jsonb,

  response_status_code integer,
  -- Truncated to ~1KB in application code before insert to avoid bloat.
  response_body_preview text,
  error_message text,

  fired_at timestamptz not null default now(),
  duration_ms integer
);

create index idx_flow_run_flow on public.flow_run(flow_id, fired_at desc);
create index idx_flow_run_action on public.flow_run(triggered_by_action_id)
  where triggered_by_action_id is not null;

-- ──────────────────────────────────────────────────────────────────
-- 4. RLS
-- ──────────────────────────────────────────────────────────────────
alter table public.flow enable row level security;
alter table public.flow_run enable row level security;

-- Any workspace member can read flows in their workspace.
create policy "members read workspace flows"
  on public.flow for select
  using (public.is_workspace_member(workspace_id));

-- Any workspace member can create flows in their workspace. created_by
-- must match the caller — prevents spoofing the creator field.
create policy "members create workspace flows"
  on public.flow for insert
  with check (
    public.is_workspace_member(workspace_id)
    and created_by = auth.uid()
  );

-- Any workspace member can update or delete workspace flows. This matches
-- how actions/projects work: small workspaces, broad trust. Tighten to
-- "creator + admin" in a later migration if needed.
create policy "members update workspace flows"
  on public.flow for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy "members delete workspace flows"
  on public.flow for delete
  using (public.is_workspace_member(workspace_id));

-- flow_run rows are readable by anyone who can read the parent flow.
-- Inserts happen from the server with the service role (Inngest function),
-- so we deliberately do not grant insert/update/delete to authenticated
-- users — the run history is server-managed.
create policy "members read workspace flow runs"
  on public.flow_run for select
  using (
    exists (
      select 1 from public.flow f
      where f.id = flow_run.flow_id
        and public.is_workspace_member(f.workspace_id)
    )
  );

comment on table public.flow is
  'User-defined automations: trigger (e.g. action status change) → action (e.g. HTTP POST). v1 single-step.';

comment on table public.flow_run is
  'Per-fire execution log for flows. Server-written only; users read via RLS.';
