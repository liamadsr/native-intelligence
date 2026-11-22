-- 678: the roadmap layout.
--
-- A view can be drawn as a roadmap: its rows on a time axis, each a bar from
-- its start to its end (components/views/view-roadmap.tsx). It is offered for
-- actions (due_at), projects (start_date, target_date) and initiatives
-- (target_date); lib/views/roadmap.ts says which kinds and which columns.
-- Saving a view as a roadmap stores `layout = 'roadmap'`, so the enum needs
-- the value. Nothing else changes: no table, column, policy or grant, so RLS
-- on `view` is exactly as it was.
--
-- Safe to run again: `add value if not exists` is a no-op once it is there.
-- (Postgres runs it outside a transaction block only before 12; on 12+ it may
-- run inside one, but the new value cannot be USED in that same transaction,
-- and nothing here uses it.)

alter type public.view_layout add value if not exists 'roadmap';
