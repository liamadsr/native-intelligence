-- Migration 397: lens findings, what a lens flow takes from a call (flows F3;
-- docs/plans/eve-alignment.md §5b "lens flows", §6 decision 6 and its
-- amendment: Triage is the ONE post-call reader).
--
-- A capture_processed flow whose skill is lens-capable (agent_config.lens,
-- migration 382) adds a prompt section and a small output schema to the one
-- Triage run on that call, and deterministic code delivers its section
-- (src/lib/flows/lens-deliver.ts). What a lens keeps lands here, one row per
-- item:
--   content    post-worthy moments in the person's own words, tagged for the
--              weekly post pass (content-skill-set.md; P8 reads status 'new'
--              and marks what it drafts from 'used');
--   marketing  objections, competitors, customer language, contradictions and
--              testimonial candidates from an external call. All but the
--              testimonials go to the product doc as section edits, at most
--              one batch a day (a batch marks its rows 'used'); testimonials
--              stay here, internal until the customer says yes (decision 8).
--
-- Nothing is on by default (§5b): rows exist only for someone who turned a
-- lens flow on. Each row belongs to the lens flow's owner (member_id), who is
-- the only member who reads it; the server writes it.
--
-- One row per (flow, capture, item): a retried or re-processed call adds no
-- duplicate (item_hash is the item's normalized text, hashed by the app). The
-- key treats NULLs as equal (a deleted flow's rows, a capture-less run).
--
-- Two functions make the two budgets atomic (F3 review S4, S5), each under a
-- transaction-scoped advisory lock, service role only:
--   claim_lens_batch         the marketing lens's product-doc batch, at most one
--                            a UTC day per workspace: claims the open findings
--                            (status 'new' -> 'claimed', at most 30 days old)
--                            only when no batch was claimed or used today. The
--                            app marks what landed 'used' and gives the rest
--                            back ('new'); a claim left over an hour is
--                            claimable again.
--   insert_post_draft_card   a post draft's For you card, only while fewer than
--                            the cap are waiting for that member (pending and
--                            not expired): decision 3's "at most 3 open".
--
-- And document.outside_derived (F3 review R2): a document whose text came
-- from outside the workspace (a file or reference ingest, a report written by
-- a run that read outside text) is marked so, for good, by the server. Agents
-- read such a document inside an outside-text fence, and reading it counts as
-- reading outside text (src/lib/safety/outside-text.ts), so its words can't be
-- laundered into canon through a stored artifact. Before, the only mark was the
-- frontmatter, which update_document can replace. Client writes can neither
-- set nor clear it (document_guard_outside_derived, in the style of 359's
-- guard: it acts only when current_user is authenticated or anon).
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word,
-- BEFORE the app ships: get_document selects document.outside_derived.
--
-- Safe to run twice.

SET LOCAL lock_timeout = '5s';

create table if not exists public.lens_finding (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  member_id uuid not null references public.member(id) on delete cascade,
  flow_id uuid references public.flow(id) on delete set null,
  capture_id uuid references public.captures(id) on delete cascade,
  lens text not null check (lens ~ '^[a-z][a-z0-9_-]{0,39}$'),
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,39}$'),
  body jsonb not null default '{}'::jsonb check (jsonb_typeof(body) = 'object'),
  item_hash text not null check (char_length(item_hash) between 1 and 64),
  status text not null default 'new' check (status in ('new', 'claimed', 'used', 'dismissed')),
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create unique index if not exists lens_finding_item_uidx
  on public.lens_finding (flow_id, capture_id, lens, item_hash) nulls not distinct;

-- The post pass and the marketing batch: one person's (or workspace's) open findings, newest first.
create index if not exists lens_finding_member_open_idx
  on public.lens_finding (member_id, lens, status, created_at desc);
create index if not exists lens_finding_workspace_idx
  on public.lens_finding (workspace_id, lens, status, used_at desc);

alter table public.lens_finding enable row level security;

-- The owner reads their own findings; every write is the server's (service role).
drop policy if exists lens_finding_select_own on public.lens_finding;
create policy lens_finding_select_own on public.lens_finding
  for select to authenticated
  using (member_id in (select m.id from public.member m where m.user_id = auth.uid()));

revoke all on public.lens_finding from anon;
revoke insert, update, delete on public.lens_finding from authenticated;
grant select on public.lens_finding to authenticated;

-- The marketing batch: at most one a UTC day per workspace and lens (S5).
create or replace function public.claim_lens_batch(
  p_workspace_id uuid,
  p_lens text,
  p_limit integer default 30
) returns setof public.lens_finding
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
begin
  perform pg_advisory_xact_lock(hashtextextended('lens_batch:' || p_workspace_id::text || ':' || p_lens, 0));
  if exists (
    select 1 from public.lens_finding
    where workspace_id = p_workspace_id and lens = p_lens
      and status in ('claimed', 'used') and used_at >= v_day_start
  ) then
    return;
  end if;
  return query
  update public.lens_finding f
  set status = 'claimed', used_at = now()
  where f.id in (
    select id from public.lens_finding
    where workspace_id = p_workspace_id and lens = p_lens and kind <> 'testimonial'
      and created_at >= now() - interval '30 days'
      and (status = 'new' or (status = 'claimed' and used_at < now() - interval '1 hour'))
    order by created_at
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  )
  returning f.*;
end
$fn$;

-- A post draft's card, under the member's open-post cap (S4).
create or replace function public.insert_post_draft_card(p_card jsonb, p_cap integer default 3)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ws uuid := (p_card ->> 'workspace_id')::uuid;
  v_member uuid := (p_card ->> 'member_id')::uuid;
  v_open integer;
begin
  if v_ws is null or v_member is null or not ((p_card -> 'payload') ? 'post_draft') then
    raise exception 'insert_post_draft_card: a post draft card needs workspace_id, member_id and payload.post_draft';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('post_draft_cards:' || v_member::text, 0));
  select count(*) into v_open from public.attention_item
  where workspace_id = v_ws and member_id = v_member and kind = 'question' and status = 'pending'
    and (payload ? 'post_draft') and (expires_at is null or expires_at > now());
  if v_open >= p_cap then
    return 'full';
  end if;
  insert into public.attention_item (
    id, workspace_id, member_id, kind, title, why, payload, proposal_id, run_key,
    entity_type, entity_id, capture_id, source_flow_run_id, expires_at
  ) values (
    coalesce(nullif(p_card ->> 'id', '')::uuid, gen_random_uuid()), v_ws, v_member, 'question',
    p_card ->> 'title', p_card ->> 'why', p_card -> 'payload', null, p_card ->> 'run_key',
    nullif(p_card ->> 'entity_type', ''), nullif(p_card ->> 'entity_id', '')::uuid, nullif(p_card ->> 'capture_id', '')::uuid,
    null, coalesce(nullif(p_card ->> 'expires_at', '')::timestamptz, now() + interval '7 days')
  );
  return 'inserted';
exception when unique_violation then
  return 'duplicate';
end
$fn$;

revoke all on function public.claim_lens_batch(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.insert_post_draft_card(jsonb, integer) from public, anon, authenticated;
grant execute on function public.claim_lens_batch(uuid, text, integer) to service_role;
grant execute on function public.insert_post_draft_card(jsonb, integer) to service_role;

-- ── document.outside_derived (R2) ──────────────────────────────────────────
alter table public.document
  add column if not exists outside_derived boolean not null default false;

comment on column public.document.outside_derived is
  'The text came from outside the workspace (a file or reference ingest, or a run that read outside text). Set by the server only, never cleared; agents read it fenced as outside text.';

create or replace function public.document_guard_outside_derived()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  -- The service role, postgres and SECURITY DEFINER functions are server paths.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.outside_derived := false;
  else
    new.outside_derived := old.outside_derived;
  end if;
  return new;
end
$fn$;
revoke execute on function public.document_guard_outside_derived() from public, anon, authenticated;

drop trigger if exists document_guard_outside_derived on public.document;
create trigger document_guard_outside_derived
  before insert or update on public.document
  for each row
  execute function public.document_guard_outside_derived();

comment on table public.lens_finding is
  'What a lens flow takes from a call (flows F3, src/lib/flows/lens-deliver.ts): content moments for the post pass, marketing findings for the product doc. Written by the server; read by its owner.';
