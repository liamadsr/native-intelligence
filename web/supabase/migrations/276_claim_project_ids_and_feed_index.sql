-- Knowledge on the views system: make "claims on project X" a real query, and
-- make the default claim list stop sorting the whole table.
--
-- ── 1. claim.project_ids ────────────────────────────────────────────────────
--
-- A claim has no project column. Its project linkage is an `entity_link` row
-- (source_type='claim', target_type='project'), and that table is POLYMORPHIC
-- with no foreign key (migration 109), so PostgREST cannot embed it and the
-- views query engine has no way to express "claims on this project" — the one
-- filter the knowledge graph has had since it shipped.
--
-- The alternatives were worse. Pre-resolving claim ids and sending them as
-- `.in('id', [...])` is an unbounded URL: a project with a few thousand claims
-- makes a request PostgREST refuses outright, and it fails at exactly the
-- workspace size where the filter matters. An RPC would work but would fork the
-- claim query into two shapes — one for "has a project filter" and one for
-- everything else — and only one of them would support the filter/sort/paginate
-- machinery every other entity gets for free.
--
-- So the link set is denormalized onto the claim as a `uuid[]`, exactly as
-- migration 259 did for `contact.prospect_list_ids` / `company.prospect_list_ids`
-- (the CRM's "From list" filter). The views system already knows how to filter
-- an array column: it becomes an ARRAY_FIELDS entry and `@>` does the work,
-- with a GIN index behind it.
--
-- Unlike 259, this one is TRIGGER-maintained rather than written by the app.
-- Claim→project links are created by several writers — the weaver, the MCP
-- tools, the AI tool-calls, ingestion — and a denormalized column that any one
-- of them can forget to update is a filter that silently returns the wrong
-- claims. The trigger makes it structural.

ALTER TABLE public.claim
  ADD COLUMN IF NOT EXISTS project_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- The filter is `project_ids @> ARRAY[project]`; GIN is the index for @>.
CREATE INDEX IF NOT EXISTS claim_project_ids_idx
  ON public.claim USING gin (project_ids);

-- Backfill from the links that already exist.
UPDATE public.claim c
   SET project_ids = sub.ids
  FROM (
    SELECT el.source_id AS claim_id,
           array_agg(DISTINCT el.target_id) AS ids
      FROM public.entity_link el
     WHERE el.source_type = 'claim'
       AND el.target_type = 'project'
     GROUP BY el.source_id
  ) sub
 WHERE c.id = sub.claim_id
   AND c.project_ids IS DISTINCT FROM sub.ids;

-- Recompute one claim's project set from the link table. Deliberately a full
-- recompute rather than an incremental array_append/array_remove: links are
-- written in bursts and sometimes duplicated (the map's own reader dedupes
-- them), and an incremental update would drift on the first double-insert or
-- double-delete. One indexed read per affected claim is cheap.
CREATE OR REPLACE FUNCTION public._claim_sync_project_ids(p_claim_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE public.claim c
     SET project_ids = COALESCE((
           SELECT array_agg(DISTINCT el.target_id)
             FROM public.entity_link el
            WHERE el.source_id = p_claim_id
              AND el.source_type = 'claim'
              AND el.target_type = 'project'
         ), '{}'::uuid[])
   WHERE c.id = p_claim_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public._claim_project_link_changed()
RETURNS TRIGGER AS $$
BEGIN
  -- Only claim→project links move this column; everything else in this very
  -- busy table returns immediately.
  IF TG_OP = 'DELETE' THEN
    IF OLD.source_type = 'claim' AND OLD.target_type = 'project' THEN
      PERFORM public._claim_sync_project_ids(OLD.source_id);
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.source_type = 'claim' AND NEW.target_type = 'project' THEN
    PERFORM public._claim_sync_project_ids(NEW.source_id);
  END IF;
  -- An UPDATE that moves a link OFF a claim has to refresh the old one too.
  IF TG_OP = 'UPDATE'
     AND OLD.source_type = 'claim' AND OLD.target_type = 'project'
     AND OLD.source_id IS DISTINCT FROM NEW.source_id THEN
    PERFORM public._claim_sync_project_ids(OLD.source_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS entity_link_claim_project_sync ON public.entity_link;
CREATE TRIGGER entity_link_claim_project_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.entity_link
  FOR EACH ROW
  EXECUTE FUNCTION public._claim_project_link_changed();

-- ── 2. The default claim feed's index ───────────────────────────────────────
--
-- The Knowledge list opens on `created_at desc` (the views default ordering)
-- over `workspace_id = $1 AND status='active' AND confirmation <> 'dismissed'`.
-- Migration 109 indexed (workspace_id), (workspace_id, type),
-- (workspace_id, confirmation) and (workspace_id, status) — none of which can
-- serve that sort, so the first page of the default view sorts every active
-- claim in the workspace, and pays it twice because the query also asks for an
-- exact count.
CREATE INDEX IF NOT EXISTS idx_claim_workspace_created_at
  ON public.claim (workspace_id, created_at DESC);

-- `event_at` is the other offered sort ("when it actually happened", migration
-- 180) and is nullable, so it gets its own ordering index with NULLS LAST to
-- match how applyOrdering emits it.
CREATE INDEX IF NOT EXISTS idx_claim_workspace_event_at
  ON public.claim (workspace_id, event_at DESC NULLS LAST);
