-- ============================================================
-- 132: Contact deduplication & merge
-- ------------------------------------------------------------
-- The same person frequently lands in the CRM as several contact rows: they
-- join one meeting from a work address and another from a personal/embedded
-- address (e.g. sarah.fletcher@ledgerline.com vs sarah.fletcher@corvanne.com), or email
-- and calendar sync each seed a row. Captures, emails and interaction history
-- then scatter across the duplicates.
--
-- This migration adds the data model + an atomic, reversible merge primitive
-- the dedup engine (src/lib/crm/contact-dedup.ts) drives:
--   * contact.merged_into_contact_id  — tombstone pointer for a merged row
--   * contact_merge                   — audit log + snapshot for undo
--   * merge_contacts()                — fold source into target atomically
--   * unmerge_contacts()              — undo a merge precisely
-- It also folds secondary_emails into the contact FTS so a merged contact is
-- still found by any of its addresses.
-- ============================================================

-- Trigram matching is used for fuzzy name comparison in the dedup engine and
-- for ad-hoc admin queries. unaccent normalises accented names.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ============================================================
-- 1. Tombstone pointer
-- ============================================================

ALTER TABLE public.contact
  ADD COLUMN IF NOT EXISTS merged_into_contact_id uuid
    REFERENCES public.contact (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.contact.merged_into_contact_id IS
  'When set, this contact has been merged into the referenced contact and '
  'should be hidden from lists/search. Its references were repointed to the '
  'target; see public.contact_merge for the snapshot and undo data.';

-- Active-contact lookups (lists, search) filter on this; the partial index
-- keeps them cheap.
CREATE INDEX IF NOT EXISTS contact_active_idx
  ON public.contact (workspace_id)
  WHERE merged_into_contact_id IS NULL;

CREATE INDEX IF NOT EXISTS contact_merged_into_idx
  ON public.contact (merged_into_contact_id)
  WHERE merged_into_contact_id IS NOT NULL;

-- Fuzzy name matching support.
CREATE INDEX IF NOT EXISTS contact_full_name_trgm_idx
  ON public.contact USING gin (full_name gin_trgm_ops);

-- ============================================================
-- 2. Merge audit log (also the undo journal)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.contact_merge (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  target_contact_id uuid REFERENCES public.contact (id) ON DELETE SET NULL,
  source_contact_id uuid REFERENCES public.contact (id) ON DELETE SET NULL,

  -- Full snapshot of the source row at merge time (to_jsonb of the row).
  source_snapshot jsonb NOT NULL,
  -- Exact ids of the rows we repointed, so undo can move them back precisely.
  moved jsonb NOT NULL DEFAULT '{}',

  -- Why we merged: 'manual', 'auto:local_part', 'auto:phone', 'auto:alias', etc.
  match_type text NOT NULL DEFAULT 'manual',
  score numeric,
  reasons jsonb NOT NULL DEFAULT '[]',
  performed_by text NOT NULL DEFAULT 'system',

  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_merge_workspace_idx
  ON public.contact_merge (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS contact_merge_target_idx
  ON public.contact_merge (target_contact_id) WHERE target_contact_id IS NOT NULL;

ALTER TABLE public.contact_merge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view contact merges"
  ON public.contact_merge FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace members can manage contact merges"
  ON public.contact_merge FOR ALL
  USING (public.is_workspace_member(workspace_id));

-- ============================================================
-- 3. Fold secondary_emails into the contact FTS
-- ============================================================
-- Drop + re-add the generated column (its index drops with it).
--
-- IMPORTANT — generated-column immutability:
--   * to_tsvector(text, text) (bare 'english' string) is only STABLE; use the
--     'english'::regconfig form, which is IMMUTABLE.
--   * array_to_string(text[], text) is only STABLE (and so is text[]::text), so
--     folding secondary_emails directly into the generated expression is
--     rejected with "generation expression is not immutable". We wrap the
--     array→space-joined-text step in an IMMUTABLE SQL helper so the whole
--     expression qualifies.

CREATE OR REPLACE FUNCTION public.contact_emails_text(emails text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$ SELECT array_to_string(coalesce(emails, '{}'), ' ') $$;

DROP INDEX IF EXISTS contact_fts_idx;
ALTER TABLE public.contact DROP COLUMN IF EXISTS fts;

ALTER TABLE public.contact ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(full_name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(email, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, public.contact_emails_text(secondary_emails)), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(notes, '')), 'B')
  ) STORED;

CREATE INDEX contact_fts_idx ON public.contact USING gin (fts);

-- ============================================================
-- 4. merge_contacts() — fold source into target atomically
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_contacts(
  p_target uuid,
  p_source uuid,
  p_match_type text DEFAULT 'manual',
  p_score numeric DEFAULT NULL,
  p_reasons jsonb DEFAULT '[]'::jsonb,
  p_performed_by text DEFAULT 'system'
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target public.contact%ROWTYPE;
  v_source public.contact%ROWTYPE;
  v_moved jsonb;
  v_emails text[];
BEGIN
  IF p_target = p_source THEN
    RAISE EXCEPTION 'Cannot merge a contact into itself';
  END IF;

  -- Lock both rows; lowest id first to avoid deadlocks between concurrent merges.
  IF p_target < p_source THEN
    SELECT * INTO v_target FROM public.contact WHERE id = p_target FOR UPDATE;
    SELECT * INTO v_source FROM public.contact WHERE id = p_source FOR UPDATE;
  ELSE
    SELECT * INTO v_source FROM public.contact WHERE id = p_source FOR UPDATE;
    SELECT * INTO v_target FROM public.contact WHERE id = p_target FOR UPDATE;
  END IF;

  IF v_target.id IS NULL OR v_source.id IS NULL THEN
    RAISE EXCEPTION 'Both contacts must exist';
  END IF;
  IF v_target.workspace_id <> v_source.workspace_id THEN
    RAISE EXCEPTION 'Contacts must be in the same workspace';
  END IF;
  IF v_source.merged_into_contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'Source contact % is already merged', p_source;
  END IF;
  IF v_target.merged_into_contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'Target contact % is already merged', p_target;
  END IF;

  -- Record the exact rows we are about to move, for a precise undo.
  v_moved := jsonb_build_object(
    'capture_participant_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.capture_participant WHERE contact_id = p_source), '[]'::jsonb),
    'contact_interaction_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.contact_interaction WHERE contact_id = p_source), '[]'::jsonb),
    'email_thread_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.email_thread_index WHERE linked_contact_id = p_source), '[]'::jsonb),
    'voice_enrollment_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.voice_enrollment WHERE contact_id = p_source), '[]'::jsonb),
    'comment_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.comment WHERE commentable_type = 'contact' AND commentable_id = p_source), '[]'::jsonb),
    'contact_share_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.contact_share WHERE contact_id = p_source), '[]'::jsonb)
  );

  -- Repoint every reference onto the surviving target.
  UPDATE public.capture_participant SET contact_id = p_target WHERE contact_id = p_source;
  UPDATE public.contact_interaction SET contact_id = p_target WHERE contact_id = p_source;
  UPDATE public.email_thread_index SET linked_contact_id = p_target WHERE linked_contact_id = p_source;
  UPDATE public.voice_enrollment SET contact_id = p_target WHERE contact_id = p_source;
  UPDATE public.comment SET commentable_id = p_target
    WHERE commentable_type = 'contact' AND commentable_id = p_source;
  UPDATE public.contact_share SET contact_id = p_target WHERE contact_id = p_source;

  -- Build the merged email set: every distinct address from both contacts,
  -- minus whatever stays as the target's primary email.
  v_emails := (
    SELECT COALESCE(array_agg(DISTINCT e), '{}')
    FROM unnest(
      COALESCE(v_target.secondary_emails, '{}')
        || COALESCE(v_source.secondary_emails, '{}')
        || ARRAY[v_source.email]
        || ARRAY[v_target.email]
    ) AS e
    WHERE e IS NOT NULL AND e <> '' AND e IS DISTINCT FROM v_target.email
  );

  -- Backfill blank target fields from the source; the target's own values win.
  UPDATE public.contact SET
    secondary_emails    = v_emails,
    first_name          = COALESCE(v_target.first_name, v_source.first_name),
    last_name           = COALESCE(v_target.last_name, v_source.last_name),
    phone               = COALESCE(v_target.phone, v_source.phone),
    avatar_url          = COALESCE(v_target.avatar_url, v_source.avatar_url),
    job_title           = COALESCE(v_target.job_title, v_source.job_title),
    department          = COALESCE(v_target.department, v_source.department),
    linkedin_url        = COALESCE(v_target.linkedin_url, v_source.linkedin_url),
    company_id          = COALESCE(v_target.company_id, v_source.company_id),
    member_id           = COALESCE(v_target.member_id, v_source.member_id),
    notes               = CASE
                            WHEN COALESCE(NULLIF(trim(v_source.notes), ''), '') = '' THEN v_target.notes
                            WHEN COALESCE(NULLIF(trim(v_target.notes), ''), '') = '' THEN v_source.notes
                            ELSE v_target.notes || E'\n\n' || v_source.notes
                          END,
    tags                = (
                            SELECT COALESCE(array_agg(DISTINCT t), '{}')
                            FROM unnest(COALESCE(v_target.tags, '{}') || COALESCE(v_source.tags, '{}')) AS t
                          ),
    interaction_count   = COALESCE(v_target.interaction_count, 0) + COALESCE(v_source.interaction_count, 0),
    last_interaction_at = GREATEST(v_target.last_interaction_at, v_source.last_interaction_at),
    next_followup_at    = COALESCE(v_target.next_followup_at, v_source.next_followup_at),
    updated_at          = now()
  WHERE id = p_target;

  -- Tombstone the source. NULLing the email frees the (workspace_id, email)
  -- unique slot and ensures future lookups resolve to the target instead.
  UPDATE public.contact SET
    merged_into_contact_id = p_target,
    email                  = NULL,
    secondary_emails       = '{}',
    updated_at             = now()
  WHERE id = p_source;

  INSERT INTO public.contact_merge (
    workspace_id, target_contact_id, source_contact_id,
    source_snapshot, moved, match_type, score, reasons, performed_by
  ) VALUES (
    v_target.workspace_id, p_target, p_source,
    to_jsonb(v_source), v_moved, p_match_type, p_score, p_reasons, p_performed_by
  );

  RETURN p_target;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.merge_contacts(uuid, uuid, text, numeric, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_contacts(uuid, uuid, text, numeric, jsonb, text) TO service_role;

-- ============================================================
-- 5. unmerge_contacts() — precise undo of a single merge
-- ============================================================
-- Restores the source row's identity from the snapshot and moves the exact
-- rows we recorded back to it. Scalar fields the target backfilled are left
-- as-is (the target keeps anything it gained); the references and addresses —
-- which is what splits the timeline — are restored exactly.

CREATE OR REPLACE FUNCTION public.unmerge_contacts(
  p_merge_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_m public.contact_merge%ROWTYPE;
  v_snap jsonb;
  v_moved jsonb;
  v_source_emails text[];
BEGIN
  SELECT * INTO v_m FROM public.contact_merge WHERE id = p_merge_id FOR UPDATE;
  IF v_m.id IS NULL THEN
    RAISE EXCEPTION 'Merge % not found', p_merge_id;
  END IF;
  IF v_m.undone_at IS NOT NULL THEN
    RAISE EXCEPTION 'Merge % was already undone', p_merge_id;
  END IF;
  IF v_m.source_contact_id IS NULL OR v_m.target_contact_id IS NULL THEN
    RAISE EXCEPTION 'Merge % is missing its source or target (deleted contact)', p_merge_id;
  END IF;

  v_snap := v_m.source_snapshot;
  v_moved := v_m.moved;

  v_source_emails := ARRAY(
    SELECT jsonb_array_elements_text(COALESCE(v_snap->'secondary_emails', '[]'::jsonb))
  );

  -- Restore the source contact's identity.
  UPDATE public.contact SET
    email                  = NULLIF(v_snap->>'email', ''),
    secondary_emails       = v_source_emails,
    merged_into_contact_id = NULL,
    updated_at             = now()
  WHERE id = v_m.source_contact_id;

  -- Drop the restored addresses from the target's secondary list so each
  -- address lives on exactly one contact again.
  UPDATE public.contact t SET
    secondary_emails = (
      SELECT COALESCE(array_agg(e), '{}')
      FROM unnest(COALESCE(t.secondary_emails, '{}')) AS e
      WHERE e IS DISTINCT FROM NULLIF(v_snap->>'email', '')
        AND NOT (e = ANY(v_source_emails))
    ),
    updated_at = now()
  WHERE t.id = v_m.target_contact_id;

  -- Move the recorded references back to the source.
  UPDATE public.capture_participant SET contact_id = v_m.source_contact_id
    WHERE id = ANY(ARRAY(SELECT (jsonb_array_elements_text(COALESCE(v_moved->'capture_participant_ids', '[]'::jsonb)))::uuid));
  UPDATE public.contact_interaction SET contact_id = v_m.source_contact_id
    WHERE id = ANY(ARRAY(SELECT (jsonb_array_elements_text(COALESCE(v_moved->'contact_interaction_ids', '[]'::jsonb)))::uuid));
  UPDATE public.email_thread_index SET linked_contact_id = v_m.source_contact_id
    WHERE id = ANY(ARRAY(SELECT (jsonb_array_elements_text(COALESCE(v_moved->'email_thread_ids', '[]'::jsonb)))::uuid));
  UPDATE public.voice_enrollment SET contact_id = v_m.source_contact_id
    WHERE id = ANY(ARRAY(SELECT (jsonb_array_elements_text(COALESCE(v_moved->'voice_enrollment_ids', '[]'::jsonb)))::uuid));
  UPDATE public.comment SET commentable_id = v_m.source_contact_id
    WHERE commentable_type = 'contact'
      AND id = ANY(ARRAY(SELECT (jsonb_array_elements_text(COALESCE(v_moved->'comment_ids', '[]'::jsonb)))::uuid));
  UPDATE public.contact_share SET contact_id = v_m.source_contact_id
    WHERE id = ANY(ARRAY(SELECT (jsonb_array_elements_text(COALESCE(v_moved->'contact_share_ids', '[]'::jsonb)))::uuid));

  UPDATE public.contact_merge SET undone_at = now() WHERE id = p_merge_id;

  RETURN v_m.source_contact_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.unmerge_contacts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unmerge_contacts(uuid) TO service_role;
