-- ============================================================
-- 367: reports and meeting preps are their own kind of document
-- (documents phase 1, item 7; docs/plans/documents-as-ground-truth.md).
-- ============================================================
-- On PROD (2026-10-19) 66 of 191 documents are skill or flow reports
-- ("{skill} — {date}") and 6 are meeting preps: over a third of the table is
-- machine output, listed alongside the documents people and agents keep.
--
-- document.kind is derived from what the writers already stamp, so no writer
-- changes and every existing row is classified at once:
--   'prep'    frontmatter has meeting_prep (src/lib/agent-events/prep-doc.ts)
--   'report'  frontmatter has skill_id (src/lib/flows/run-skill.ts; every
--             report is stamped from this phase on, not only a loop fire's)
--   'doc'     everything else
-- A generated column rather than a new `type` value: `type` feeds the edit
-- rule (a non-note type is a shared wiki page any member may edit, 359), and
-- a report must not become member-editable by being classified.
--
-- The default document lists (list_documents, the Docs cards) show 'doc'
-- only, unless asked for reports or preps. Search still finds all three.
--
-- Rollout: DEV, then PROD BEFORE the app PR merges (the app filters on
-- kind). Adding a stored generated column rewrites the table: 191 rows on
-- PROD, instant. Idempotent. No backslash anywhere in this file (the MCP
-- apply tool decodes them). The rewrite takes an ACCESS EXCLUSIVE lock: it
-- waits at most 5 seconds for one rather than queue every document read
-- behind a long transaction (retry the apply if it times out).

SET LOCAL lock_timeout = '5s';

alter table public.document
  add column if not exists kind text
  generated always as (
    case
      when frontmatter ? 'meeting_prep' then 'prep'
      when frontmatter ? 'skill_id' then 'report'
      else 'doc'
    end
  ) stored;

create index if not exists idx_document_workspace_kind
  on public.document (workspace_id, kind, updated_at desc)
  where status <> 'archived';
