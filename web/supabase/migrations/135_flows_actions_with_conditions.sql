-- 132_flows_actions_with_conditions.sql
--
-- Generalize Flows from (1 trigger + 1 http_post action) to
-- (1 trigger -> an ORDERED LIST of N http_post actions, each with an
--  optional AND/OR condition on the triggering entity's fields).
--
-- ──────────────────────────────────────────────────────────────────
-- BASELINE
-- ──────────────────────────────────────────────────────────────────
-- Written against the live baseline verified 2026-06-15: DEV and PRD both
-- still carry the legacy single-action shape (action_type / action_config /
-- bearer_token_encrypted columns, team_id NOT NULL, the flow_trigger_type /
-- flow_action_type enums intact, no `actions` column). This is the first
-- migration to touch the flow tables since 129 (canvas_layout).
--
-- The shape here matches what v1 actually ships: N homogeneous http_post
-- actions, each with an optional condition, each carrying its own bearer
-- token. We deliberately keep it tight — no generic `steps[]` registry,
-- `secrets` map, or per-action child table (those were speculative; no
-- run_skill / mcp_call / create_action surface exists yet) — and would add a
-- `graph` jsonb later if branching is ever needed, without invalidating
-- these rows. Every statement is idempotent (IF [NOT] EXISTS / column probes)
-- so a re-run, or a run after the legacy columns are gone, is a no-op.
--
-- ──────────────────────────────────────────────────────────────────
-- DESIGN CHOICES
-- ──────────────────────────────────────────────────────────────────
--
-- 1. ACTIONS AS A jsonb ARRAY ON flow (not a child flow_action table).
--    v1 is a linear, ordered, small-N pipeline: no branching, no fan-out,
--    no cross-row references. A jsonb `actions` column keeps the whole flow
--    definition in one row — the dispatcher loads it in a single SELECT, a
--    reorder is one UPDATE, and it matches the existing "jsonb shape IS the
--    contract" pattern already validated in src/lib/flows/queries.ts. A child
--    table would buy referential integrity we don't need for ordered config
--    and would cost N joins on the dispatch hot path for the privilege of
--    fetching 2-3 rows we always want together. If branching ever arrives we
--    add a `graph` jsonb without invalidating these rows.
--
-- 2. trigger_type enum -> text + CHECK.
--    The trigger registry is fast-moving (entity_status_change today;
--    capture_processed / pr_status_changed / schedule next). A text column
--    with a CHECK is extended by dropping & re-adding the CHECK in a normal
--    migration — no `ALTER TYPE ... ADD VALUE` transaction gymnastics, and
--    enum values can never be removed once added. The single trigger shape
--    is unchanged (trigger_config jsonb stays).
--
-- 3. PER-ACTION BEARER TOKEN, encrypted individually.
--    Each http_post may hit a different service (Anthropic routine, a Slack
--    webhook, an internal API), so each action carries its own optional
--    bearer_token_encrypted (aes-256-gcm "v1.iv.tag.ct" — same format as the
--    legacy single column, src/lib/crypto/credentials.ts). The legacy single
--    bearer_token_encrypted is migrated into actions[0].bearer_token_encrypted.
--    NEVER returned to clients — the API maps it to bearer_token_present:bool
--    per action (see toPublicFlow in queries.ts).
--
-- 4. PER-ACTION CONDITION (optional AND/OR group) on the triggering entity.
--    actions[i].condition is a ConditionGroup | null:
--      { match: 'all' | 'any', rules: ConditionRule[] }
--    Evaluated by the runner against the entity that fired the trigger; a
--    null/absent condition always runs. Rules are minimal but real — see
--    src/lib/flows/types.ts for per-field value semantics. Validated in app
--    code; the DB only enforces that `actions` is an array.
--
-- 5. N-ACTION RUN LOGGING -> flow_run.action_results jsonb (NOT a child table).
--    flow_run stays one-row-per-FLOW-fire. Per-action outcomes live in a
--    jsonb array action_results = [{ action_id, condition_met, skipped,
--    status, response_status_code, response_body_preview, error_message,
--    duration_ms }]. For v1 we read a run's detail as a whole (UI shows the
--    fire then expands its actions) — we never query "all failed actions
--    across runs", so a child table's per-row indexing/append wins nothing
--    and costs a join + an extra write per action. flow_run.status stays the
--    worst-of the EXECUTED (non-skipped) actions: failed > success > pending.
--    A skipped-only fire is 'success'.
--
-- IDEMPOTENT: every statement guards with IF [NOT] EXISTS / column probes.
-- The legacy->actions backfill only runs for rows not already migrated, so a
-- re-run (or a run after the legacy columns are gone) is a no-op. Existing
-- rows' INTENT is preserved: the single (action_config + bearer token)
-- collapses into a 1-element actions[] with condition:null.

begin;

-- ──────────────────────────────────────────────────────────────────
-- 1. Drop the dispatch index that pins the trigger_type enum column.
--    Rebuilt at the end against the new text column.
-- ──────────────────────────────────────────────────────────────────
drop index if exists public.idx_flow_dispatch;

-- ──────────────────────────────────────────────────────────────────
-- 2. flow.trigger_type: enum -> text + CHECK (only if still the enum).
-- ──────────────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'flow'
      and column_name = 'trigger_type' and udt_name = 'flow_trigger_type'
  ) then
    alter table public.flow
      alter column trigger_type type text using trigger_type::text;
  end if;
end $$;

alter table public.flow drop constraint if exists flow_trigger_type_check;
alter table public.flow
  add constraint flow_trigger_type_check
  check (trigger_type in (
    'entity_status_change',
    'capture_processed',
    'pr_status_changed',
    'schedule'
  ));

-- ──────────────────────────────────────────────────────────────────
-- 3. flow: add the ordered actions[] column.
-- ──────────────────────────────────────────────────────────────────
-- Shape (validated in src/lib/flows/queries.ts):
--   [
--     {
--       "id": "<stable uuid/nanoid>",          -- stable across edits; keys canvas_layout + action_results
--       "type": "http_post",                    -- only value in v1; widen via app validator
--       "config": { "method", "url", "headers", "body_template" },
--       "condition": { "match": "all"|"any", "rules": [...] } | null,
--       "bearer_token_encrypted": "<aes-256-gcm v1.iv.tag.ct>"  -- optional, per-action
--     },
--     ...
--   ]
-- Array order = execution order. Empty array = no-op flow.
alter table public.flow
  add column if not exists actions jsonb not null default '[]'::jsonb;

alter table public.flow drop constraint if exists flow_actions_is_array;
alter table public.flow
  add constraint flow_actions_is_array
  check (jsonb_typeof(actions) = 'array');

-- ──────────────────────────────────────────────────────────────────
-- 4. Backfill: collapse legacy (action_type, action_config,
--    bearer_token_encrypted) into a 1-element actions[] (condition: null).
-- ──────────────────────────────────────────────────────────────────
-- Only touches rows that (a) still have an empty actions[] and (b) still
-- carry a legacy action_type column. Re-running after the legacy columns
-- are dropped is a no-op (the IF EXISTS guard short-circuits).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'flow'
      and column_name = 'action_type'
  ) then
    update public.flow f
    set actions = jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'id', gen_random_uuid()::text,
          'type', f.action_type::text,
          'config', coalesce(f.action_config, '{}'::jsonb),
          'condition', null,
          'bearer_token_encrypted', f.bearer_token_encrypted  -- null is stripped
        )
      )
    )
    where jsonb_array_length(f.actions) = 0
      and f.action_type is not null;
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────
-- 5. flow_run: add action_results jsonb (per-action outcomes).
-- ──────────────────────────────────────────────────────────────────
-- One flow_run row per FLOW fire (unchanged). action_results is the ordered
-- per-action log:
--   [
--     {
--       "action_id": "<flow.actions[i].id>",
--       "condition_met": true,        -- did the action's condition pass? (true if no condition)
--       "skipped": false,             -- true iff condition_met=false (action not executed)
--       "status": "success"|"failed"|"pending",
--       "response_status_code": 200,  -- null when skipped or no HTTP response
--       "response_body_preview": "...", -- ~1KB cap in app; null when skipped
--       "error_message": null,
--       "duration_ms": 142            -- 0/null when skipped
--     },
--     ...
--   ]
-- The legacy top-level snapshot columns (request_summary, response_status_code,
-- response_body_preview, error_message, duration_ms) are KEPT: for a single-
-- action flow they mirror action_results[0] so existing run-list UI keeps
-- working without per-action expansion. flow_run.status is the worst-of the
-- EXECUTED (non-skipped) actions.
alter table public.flow_run
  add column if not exists action_results jsonb not null default '[]'::jsonb;

alter table public.flow_run drop constraint if exists flow_run_action_results_is_array;
alter table public.flow_run
  add constraint flow_run_action_results_is_array
  check (jsonb_typeof(action_results) = 'array');

-- ──────────────────────────────────────────────────────────────────
-- 6. canvas_layout: widen shape from { trigger, action } to per-action keys.
-- ──────────────────────────────────────────────────────────────────
-- Column exists (migration 129), stays jsonb. Shape generalizes to:
--   { "trigger": {x,y}, "action:<actionId>": {x,y}, ... }
-- No data migration: the editor re-lays-out a node when its key is missing,
-- and the legacy "action" key (pre-132) maps to actions[0] on first open.
comment on column public.flow.canvas_layout is
  'UI-only node positions. Shape: { "trigger": {x,y}, "action:<actionId>": {x,y}, ... }. Legacy "action" key (pre-132) maps to actions[0]. Pure presentation — no effect on matching/runner.';

-- ──────────────────────────────────────────────────────────────────
-- 7. Drop the legacy single-action columns (greenfield: no backcompat).
-- ──────────────────────────────────────────────────────────────────
-- Order matters: drop the columns BEFORE the enum type they depend on.
-- Safe to run repeatedly (IF EXISTS) and after the backfill above has
-- captured their values into actions[].
alter table public.flow drop column if exists action_type;
alter table public.flow drop column if exists action_config;
alter table public.flow drop column if exists bearer_token_encrypted;

-- ──────────────────────────────────────────────────────────────────
-- 8. Relax team_id to nullable.
-- ──────────────────────────────────────────────────────────────────
-- Future triggers (schedule, capture_processed) are workspace-scoped, not
-- team-scoped. entity_status_change flows still set team_id; the dispatcher
-- already tolerates a null team for non-action entities.
alter table public.flow alter column team_id drop not null;

-- ──────────────────────────────────────────────────────────────────
-- 9. Rebuild the dispatch hot-path index against the text column.
-- ──────────────────────────────────────────────────────────────────
create index if not exists idx_flow_dispatch
  on public.flow(workspace_id, trigger_type)
  where enabled = true;
-- Keep the per-team lookup for entity_status_change flows.
create index if not exists idx_flow_team on public.flow(team_id);

-- ──────────────────────────────────────────────────────────────────
-- 10. Drop the now-unused enums (kept only flow_run_status).
-- ──────────────────────────────────────────────────────────────────
-- flow_run_status stays an enum: its values (pending/success/failed) are
-- stable + closed. The trigger/action enums are replaced by text+CHECK /
-- the per-action type field.
drop type if exists public.flow_action_type;
drop type if exists public.flow_trigger_type;

-- ──────────────────────────────────────────────────────────────────
-- 11. Refresh table/column documentation.
-- ──────────────────────────────────────────────────────────────────
comment on table public.flow is
  'User-defined automations: one trigger -> an ordered list of N http_post actions, each with an optional AND/OR condition on the triggering entity. actions[] is a jsonb array; order = execution order. Per-action bearer tokens stored encrypted (aes-256-gcm) inside each action.';

comment on column public.flow.actions is
  'Ordered action pipeline. Array of { id, type:''http_post'', config:{method,url,headers,body_template}, condition: ConditionGroup|null, bearer_token_encrypted? }. condition gates execution against the triggering entity. bearer_token_encrypted is aes-256-gcm ciphertext (src/lib/crypto/credentials.ts) — never returned to clients.';

comment on column public.flow_run.action_results is
  'Per-action outcomes for this fire. Array of { action_id, condition_met, skipped, status, response_status_code, response_body_preview, error_message, duration_ms }. flow_run.status is the worst-of the executed (non-skipped) actions.';

commit;
