-- ============================================================
-- 377: when each section of a canon document was last checked
-- (canon documents D3; documents-as-ground-truth.md §3.5).
-- ============================================================
-- One row per top-level (##) section of a canon document:
--   section            the heading, lower-cased (the row's key in its document)
--   heading            the heading as written
--   content_hash       the section's text as of the check, hashed, so the
--                      nightly pass sees a person's edit in the editor (hash
--                      changed: checked as of the document's last change)
--   last_verified_at   when it was last edited or marked checked: past 90
--                      days the document view shows a quiet "not checked
--                      since" marker on it (no card asks)
--   verified_by        the member who did (an edit's author, or whoever
--                      marked it checked); null when unknown
--   verified_kind      'edit' (a change the nightly pass saw), 'agent' (a canon
--                      section edit, canon-edit.ts), 'confirmed' (someone
--                      marked it checked)
--
-- Written only by the server (service role): the canon edit path, the
-- marker's "Mark checked", and the 04:00 maintenance pass
-- (src/lib/documents/canon-freshness.ts). A member reads the rows of the
-- documents they can see (document_visible_to, 369); no client writes.
--
-- Rollout: DEV, then PROD BEFORE the app PR merges. Idempotent. No backslash
-- anywhere in this file (the MCP apply tool decodes them).

SET LOCAL lock_timeout = '5s';

create table if not exists public.document_section_check (
  document_id uuid not null references public.document(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  section text not null check (char_length(section) between 1 and 200),
  heading text not null check (char_length(heading) between 1 and 200),
  content_hash text not null check (char_length(content_hash) between 1 and 64),
  last_verified_at timestamptz not null default now(),
  verified_by uuid references public.member(id) on delete set null,
  verified_kind text not null default 'edit' check (verified_kind in ('edit', 'agent', 'confirmed')),
  primary key (document_id, section)
);

create index if not exists document_section_check_stale_idx
  on public.document_section_check (workspace_id, last_verified_at);

alter table public.document_section_check enable row level security;

drop policy if exists "document_section_check_select" on public.document_section_check;
create policy "document_section_check_select" on public.document_section_check
  for select to authenticated
  using (public.is_workspace_member(workspace_id) and public.document_visible_to(document_id, (select auth.uid())));

revoke all on public.document_section_check from anon, authenticated;
grant select on public.document_section_check to authenticated;

comment on table public.document_section_check is
  'When each ## section of a canon document was last edited or marked checked (377, canon D3). Server-written only.';
