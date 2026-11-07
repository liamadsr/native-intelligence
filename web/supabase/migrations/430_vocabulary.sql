-- ============================================================
-- 430: custom vocabulary — words transcription gets wrong
-- ============================================================
-- Decision, 2026-10-24 (Liam): a user dictionary so the words a team says
-- every day (product names, people, acronyms: "Supabase", "Dial8", "RLS")
-- come out right in meeting transcripts and dictation, on Deepgram and the
-- on-device engine alike. Plan: docs/plans/custom-vocabulary.md §9-§10.
--
-- The words are applied AFTER recognition, by sound (src/lib/vocabulary/
-- sound-match.ts), so the list has no size cap and nothing here reaches the
-- speech engines. Names Dial8 already knows (workspace-visible contacts and
-- companies, teammates, projects, the assistant's name) are added
-- automatically and never stored here, except as a hidden row when someone
-- turns one off (source 'auto', status 'dismissed').
--
-- Ownership (Liam, 2026-10-24: "workspace + personal"): a row with no user_id
-- is the workspace's, shared by every member; a row with a user_id is that
-- person's own. Any member may add, edit or remove the workspace's
-- words (like labels); a personal row is its owner's alone.
--
-- Learning (Liam, 2026-10-24: "this all should happen automatically" — no AI
-- job, nothing for anyone to approve): the right spellings are already in
-- what the team writes. A background scan (src/lib/vocabulary/harvest.ts, no
-- model call) keeps source 'workspace' rows in step with the words in
-- workspace documents and confirmed actions (the workspace's rows) and in a
-- person's own chat messages and private documents (that person's rows).
-- They are live at once. Anyone can turn one off for themselves.
--
-- What changes:
--   vocabulary_term   NEW table: workspace, owner (null = workspace), the term
--                     as it should be written (1-60 chars), sounds_like (other
--                     ways it is heard or written, at most 20), status
--                     (active | dismissed), source (manual | agent |
--                     workspace | auto), evidence (jsonb: a harvested word's
--                     counts), created_by, created/updated times.
--   vocabulary_term_key           NEW unique index: one row per term per owner
--                                 (case- and space-insensitive).
--   vocabulary_term_ws_status_idx NEW index: a workspace's rows by status.
--   vocabulary_term_updated_at    NEW trigger: public.update_updated_at() (013).
--   RLS               members read and write the workspace's rows; a personal
--                     row only its owner — select, insert, update and delete,
--                     each with public.is_workspace_member (the 321 pattern).
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Without it Settings > Vocabulary and the vocabulary tools fail to load or
-- save (the table is missing) and transcripts are corrected with the
-- automatic names only; nothing else changes.
--
-- Idempotent: create if not exists, drop policy / trigger if exists before
-- creating them, revoke/grant restate the full privilege set. This file holds
-- no backslash anywhere: one MCP transport decodes escapes, so the applied SQL
-- would differ from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

create table if not exists public.vocabulary_term (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  -- Null: the workspace's (every member). Set: that person's own.
  user_id uuid references auth.users(id) on delete cascade,
  term text not null,
  sounds_like text[] not null default '{}',
  status text not null default 'active',
  source text not null default 'manual',
  -- Harvested rows (source 'workspace'): { count, sources }.
  evidence jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vocabulary_term_term_check check (char_length(btrim(term)) between 1 and 60),
  constraint vocabulary_term_status_check check (status in ('active', 'dismissed')),
  constraint vocabulary_term_source_check check (source in ('manual', 'agent', 'workspace', 'auto')),
  constraint vocabulary_term_sounds_like_check check (cardinality(sounds_like) <= 20)
);

comment on table public.vocabulary_term is
  'Custom vocabulary (430): words transcription gets wrong, applied after recognition by sound (src/lib/vocabulary). user_id null = the workspace''s; set = that person''s. Source workspace = harvested automatically from what the team writes.';

create unique index if not exists vocabulary_term_key
  on public.vocabulary_term (workspace_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(term)));

create index if not exists vocabulary_term_ws_status_idx
  on public.vocabulary_term (workspace_id, status);

drop trigger if exists vocabulary_term_updated_at on public.vocabulary_term;
create trigger vocabulary_term_updated_at
  before update on public.vocabulary_term
  for each row execute function public.update_updated_at();

alter table public.vocabulary_term enable row level security;

drop policy if exists "vocabulary_term_select" on public.vocabulary_term;
create policy "vocabulary_term_select"
  on public.vocabulary_term for select
  to authenticated
  using (public.is_workspace_member(workspace_id) and (user_id is null or user_id = (select auth.uid())));

drop policy if exists "vocabulary_term_insert" on public.vocabulary_term;
create policy "vocabulary_term_insert"
  on public.vocabulary_term for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id) and (user_id is null or user_id = (select auth.uid())));

drop policy if exists "vocabulary_term_update" on public.vocabulary_term;
create policy "vocabulary_term_update"
  on public.vocabulary_term for update
  to authenticated
  using (public.is_workspace_member(workspace_id) and (user_id is null or user_id = (select auth.uid())))
  with check (public.is_workspace_member(workspace_id) and (user_id is null or user_id = (select auth.uid())));

drop policy if exists "vocabulary_term_delete" on public.vocabulary_term;
create policy "vocabulary_term_delete"
  on public.vocabulary_term for delete
  to authenticated
  using (public.is_workspace_member(workspace_id) and (user_id is null or user_id = (select auth.uid())));

-- Members read and write the workspace's words and their own (the policies
-- above); Supabase's default grants (truncate, trigger, references…) go.
revoke all on table public.vocabulary_term from anon, authenticated;
grant select, insert, update, delete on table public.vocabulary_term to authenticated;
