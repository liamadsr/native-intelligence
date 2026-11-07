-- ============================================================
-- 378: when a report or a meeting prep was last opened
-- (decision 18, eve-alignment.md §6; documents-as-ground-truth.md §3.6).
-- ============================================================
-- Decision 18: a skill or loop report and a meeting prep (document.kind
-- 'report' / 'prep', 367) archive themselves after 30 days unless someone
-- opened or linked them. Archive means hidden from lists and search, never
-- deleted, and still reachable from the flow's run history (by id).
--
-- The document row can't carry the stamp: every update to it moves
-- updated_at (025's trigger), which would make a read look like an edit.
-- So one row per document, in its own table:
--   document_open.last_opened_at   when a person last opened it in the app
--                                  (GET /api/account/documents/[id]), at most
--                                  one write a day per document
--                                  (note_document_open)
-- Only reports and preps are stamped; nothing else reads it but the
-- maintenance pass (src/lib/documents/report-archive.ts).
--
-- Service role only: the route stamps after its own access check. No client
-- reads or writes it.
--
-- Rollout: DEV, then PROD BEFORE the app PR merges. Idempotent. No backslash
-- anywhere in this file (the MCP apply tool decodes them).

SET LOCAL lock_timeout = '5s';

create table if not exists public.document_open (
  document_id uuid primary key references public.document(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  last_opened_at timestamptz not null default now()
);

create index if not exists document_open_workspace_idx
  on public.document_open (workspace_id, last_opened_at);

alter table public.document_open enable row level security;
revoke all on public.document_open from anon, authenticated;

create or replace function public.note_document_open(p_document_id uuid, p_workspace_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.document_open (document_id, workspace_id, last_opened_at)
  select d.id, d.workspace_id, now()
    from public.document d
   where d.id = p_document_id
     and d.workspace_id = p_workspace_id
  on conflict (document_id) do update
     set last_opened_at = now()
   where public.document_open.last_opened_at < now() - interval '1 day';
$$;

comment on function public.note_document_open(uuid, uuid) is
  'Stamp that a person opened a report or prep (378, decision 18): at most once a day per document, fenced to its workspace. Service role only.';

revoke all on function public.note_document_open(uuid, uuid) from public, anon, authenticated;
grant execute on function public.note_document_open(uuid, uuid) to service_role;
