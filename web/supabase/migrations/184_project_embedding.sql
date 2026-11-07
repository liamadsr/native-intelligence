-- Migration 184: project_embedding — the weaver's project name+description
-- embedding cache (knowledge-recall plan item 17, weaver Phase 2b).
--
-- The nightly weaver's claim↔project judge (knowledge-weaver.ts) links claims
-- that ended the claim↔claim pass with zero `about→project` edges to the
-- best-fit project. Its first tier is a cosine match of the claim's ALREADY-
-- computed claim_chunks embedding against each project's embedding — so the
-- project name+description must be embedded ONCE and cached, not re-embedded
-- every run.
--
-- This table is that cache. One row per project. `embedding` is OpenAI
-- text-embedding-3-small (1536-d) — the SAME space as claim_chunks (migration
-- 113), so the weaver can cosine-compare the two directly without a second
-- model. `source_updated_at` records the project.updated_at that was embedded;
-- the weaver re-embeds only when the project's current updated_at is newer
-- (name/description edited since), keeping cost near-zero on quiet workspaces.
--
-- SAFETY: rows are written ONLY by server code (the weaver, service-role). RLS
-- is enabled with NO client policies — this is a pure internal derived cache no
-- client needs to read or write (same posture as tracked_job, migration 170).
-- service_role bypasses RLS, so the weaver still reads/writes it.

create table if not exists public.project_embedding (
  project_id uuid primary key references public.projects(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,

  -- OpenAI text-embedding-3-small, 1536-d — same space as claim_chunks so the
  -- weaver's cosine claim↔project match needs no second embedding model.
  embedding vector(1536) not null,

  -- The projects.updated_at that was embedded. The weaver re-embeds only when
  -- the live project.updated_at is strictly newer than this (name/description
  -- changed), so an unchanged project is embedded exactly once, ever.
  source_updated_at timestamptz not null,

  updated_at timestamptz not null default now()
);

-- The weaver loads every project embedding for a workspace in one shot.
create index if not exists project_embedding_workspace_idx
  on public.project_embedding (workspace_id);

alter table public.project_embedding enable row level security;

-- No client policies: this derived cache is written and read ONLY by the
-- service-role weaver (which bypasses RLS). Enabling RLS with no policies
-- denies all client (authenticated/anon) access by default — the deny-all
-- posture the plan calls for.
