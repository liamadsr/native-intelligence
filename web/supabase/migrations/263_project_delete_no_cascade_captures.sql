-- 263: a project delete must never RAW-delete captures (knowledge-graph orphans).
--
-- THE BUG. `captures.project_id` carried a `notes_project_id_fkey` FK with
-- ON DELETE CASCADE — the constraint name outlived the notes → captures rename
-- in migration 025. Deleting a project therefore made Postgres raw-delete every
-- capture in it, with ZERO application involvement, completely bypassing
-- `delete_capture_with_knowledge` (migration 178, re-signed in 237).
--
-- That RPC is the ONLY correct capture teardown. claim_source.source_id and
-- entity_link.{source,target}_id are polymorphic bare UUIDs with NO foreign key
-- (migration 109), so nothing at the DB level follows a capture's provenance:
-- the cascade deleted the row and left every claim sole-sourced by it stranded
-- as evidence-orphaned, while its embeddings survived and kept surfacing in RAG.
-- This is the confirmed root cause of PROD's evidence-orphaned claims doubling.
--
-- The route (/api/account/projects/[id] DELETE) meant to do this teardown in
-- application code, but its capture delete named the pre-025 `notes` table, so
-- the call errored against a nonexistent relation and — with its error never
-- checked — silently no-opped. The cascade was doing all the work, invisibly.
-- That route now selects the project's captures and routes each through the RPC.
--
-- THE FIX. Convert the project_id cascades to ON DELETE SET NULL. Deleting a
-- project still deletes its captures — the route does it, correctly, through the
-- RPC — but any future project deletion that happens OUTSIDE that route (a
-- direct SQL delete, an admin tool, a cascade from a parent project, a service
-- job) now UNLINKS the captures instead of destroying knowledge. Losing a
-- project_id is recoverable; a raw-deleted capture with orphaned claims is not.
--
-- AUDIT. Every FK referencing public.projects was checked on DEV and PROD (both
-- identical). Two carried a project_id-driven CASCADE onto source-bearing rows:
--
--   notes_project_id_fkey        captures        → converted below
--   note_chunks_project_id_fkey  capture_chunks  → converted below
--
-- capture_chunks holds the retrieval embeddings for capture text. Its
-- project_id cascade is a SECOND, independent bypass: a project delete wiped a
-- capture's chunks even when the capture itself survived (an unlinked capture
-- would go silently unsearchable). Its sibling `document_chunks.project_id` is
-- already SET NULL, which is the intended shape here.
--
-- Deliberately LEFT AS CASCADE — these delete from their OWN parent row, not
-- from project_id, which is correct and must stay:
--   note_chunks_note_id_fkey (capture_chunks → captures)
--   document_chunks_document_id_fkey (document_chunks → document)
--   attachment_chunks_attachment_id_fkey (attachment_chunks → attachments)
-- Also left alone: milestone, project_label, project_local_path and
-- project_embedding cascade from project_id but hold no source material — they
-- are project-owned rows that are meaningless without their project.
-- attachments, document, decision, actions and capture_references already
-- carry SET NULL on project_id.
--
-- Idempotent: the constraint is discovered by its column (not its legacy name)
-- and re-added only when it is still a CASCADE.

DO $$
DECLARE
  v_conname text;
BEGIN
  -- ── captures.project_id ────────────────────────────────────────────────
  -- Discovered by column rather than hardcoding 'notes_project_id_fkey': the
  -- name is a rename artifact and may differ on a freshly built database.
  SELECT c.conname INTO v_conname
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.conrelid = 'public.captures'::regclass
     AND c.confrelid = 'public.projects'::regclass
     AND c.conkey = ARRAY[(
       SELECT a.attnum FROM pg_attribute a
        WHERE a.attrelid = 'public.captures'::regclass AND a.attname = 'project_id'
     )]
     AND c.confdeltype = 'c';  -- only act while it is still CASCADE

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.captures DROP CONSTRAINT %I', v_conname);
    ALTER TABLE public.captures
      ADD CONSTRAINT captures_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES public.projects (id) ON DELETE SET NULL;
  END IF;

  -- ── capture_chunks.project_id ─────────────────────────────────────────
  v_conname := NULL;
  SELECT c.conname INTO v_conname
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.conrelid = 'public.capture_chunks'::regclass
     AND c.confrelid = 'public.projects'::regclass
     AND c.conkey = ARRAY[(
       SELECT a.attnum FROM pg_attribute a
        WHERE a.attrelid = 'public.capture_chunks'::regclass AND a.attname = 'project_id'
     )]
     AND c.confdeltype = 'c';

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.capture_chunks DROP CONSTRAINT %I', v_conname);
    ALTER TABLE public.capture_chunks
      ADD CONSTRAINT capture_chunks_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES public.projects (id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON CONSTRAINT captures_project_id_fkey ON public.captures IS
  'SET NULL, never CASCADE: a raw capture delete strands claim_source/entity_link '
  'provenance (polymorphic, no FK — migration 109). Capture teardown belongs to '
  'delete_capture_with_knowledge (migration 178).';
