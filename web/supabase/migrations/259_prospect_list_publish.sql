-- Migration 259: a prospect list PUBLISHES into the CRM as a group.
--
-- Liam, 2026-09-06: "adding a bunch of random contacts to your CRM can get
-- really messy quickly… every list that you create becomes a group of
-- contacts… we shouldn't even have an add-to-CRM button at the company level
-- or at the person level, we should have it at the list level… once you
-- finalize it, it gets created as a group in the CRM, and they all get saved…
-- there should be a way for me to explicitly say, give me all the contacts or
-- companies that originated from the US B2B SaaS Outbound Teams list."
--
-- WHAT CHANGES. Save on a row used to BE promotion (a CRM company/contact row
-- appeared on the click). Now Save is curation — "keep this on the list" —
-- and PUBLISH is the one thing that writes to the CRM: it promotes every
-- saved entry the CRM does not hold yet, stamps `published_at` on those
-- entries and on the list, and records the list's id on each CRM row.
--
-- THE LIST IS THE GROUP. No third noun: the CRM filters contacts and
-- companies by the prospect lists they were published from, so the tie-back
-- Liam asked for is a column on the record, not a join through the entry
-- table. A record can belong to several lists; `prospect_list_ids` is an
-- array for exactly that reason.
--
-- REMOVAL IS SOFT. Dismissing a published company takes it (and its published
-- people) out of the group — `array_remove` — and never deletes the CRM row:
-- interactions, sequences and other lists may reference it.
--
-- BACKFILL. Every entry Save already promoted (stage 'saved' AND a CRM id) is
-- treated as published, because that is what Save used to mean; its CRM row
-- gets the list id, and the list gets a `published_at`. Nothing the old model
-- did is lost, it is just named.

-- ── The list ─────────────────────────────────────────────────────────────
ALTER TABLE public.prospect_list
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── The entry ────────────────────────────────────────────────────────────
-- NULL = saved to the list but not (or no longer) in the CRM group. Cleared
-- when an entry leaves `saved` (dismissed, restored to discovered), so
-- "pending publish" is always `stage = 'saved' AND published_at IS NULL`.
ALTER TABLE public.prospect_list_entry
  ADD COLUMN IF NOT EXISTS published_at timestamptz;

CREATE INDEX IF NOT EXISTS prospect_entry_pending_publish_idx
  ON public.prospect_list_entry (list_id)
  WHERE stage = 'saved' AND published_at IS NULL;

-- ── The CRM rows: which lists each came from ─────────────────────────────
ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS prospect_list_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
ALTER TABLE public.contact
  ADD COLUMN IF NOT EXISTS prospect_list_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- The CRM's "From list" filter is `prospect_list_ids @> ARRAY[list]`; GIN is
-- the index that serves containment on an array.
CREATE INDEX IF NOT EXISTS company_prospect_list_ids_idx
  ON public.company USING gin (prospect_list_ids);
CREATE INDEX IF NOT EXISTS contact_prospect_list_ids_idx
  ON public.contact USING gin (prospect_list_ids);

-- ── Backfill: what Save used to mean ─────────────────────────────────────
UPDATE public.prospect_list_entry
   SET published_at = COALESCE(updated_at, created_at)
 WHERE stage = 'saved'
   AND published_at IS NULL
   AND (company_id IS NOT NULL OR contact_id IS NOT NULL);

UPDATE public.company c
   SET prospect_list_ids = sub.ids
  FROM (
    SELECT company_id, array_agg(DISTINCT list_id) AS ids
      FROM public.prospect_list_entry
     WHERE stage = 'saved' AND company_id IS NOT NULL AND published_at IS NOT NULL
     GROUP BY company_id
  ) sub
 WHERE c.id = sub.company_id;

UPDATE public.contact ct
   SET prospect_list_ids = sub.ids
  FROM (
    SELECT contact_id, array_agg(DISTINCT list_id) AS ids
      FROM public.prospect_list_entry
     WHERE stage = 'saved' AND contact_id IS NOT NULL AND published_at IS NOT NULL
     GROUP BY contact_id
  ) sub
 WHERE ct.id = sub.contact_id;

UPDATE public.prospect_list l
   SET published_at = sub.last_published
  FROM (
    SELECT list_id, max(published_at) AS last_published
      FROM public.prospect_list_entry
     WHERE published_at IS NOT NULL
     GROUP BY list_id
  ) sub
 WHERE l.id = sub.list_id AND l.published_at IS NULL;

-- ── The two writes publish/unpublish make on CRM rows ────────────────────
--
-- SQL functions rather than read-modify-write from the app: a publish of 50
-- companies and 150 people is ONE round trip per table instead of 200, and
-- `array_append` under a `NOT (… @> …)` guard is idempotent — a second
-- publish of the same rows writes nothing.
--
-- SECURITY DEFINER with an explicit membership check (the same
-- `is_workspace_member` the RLS policies use), because a member publishing a
-- list must be able to stamp a contact another member created. The service
-- role (Scout's lanes) passes the check by role. Never callable anonymously.

CREATE OR REPLACE FUNCTION public.prospect_list_mark_published(
  p_workspace uuid,
  p_list uuid,
  p_company_ids uuid[],
  p_contact_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.is_workspace_member(p_workspace) THEN
    RAISE EXCEPTION 'not a member of workspace %', p_workspace USING ERRCODE = '42501';
  END IF;

  UPDATE public.company
     SET prospect_list_ids = array_append(prospect_list_ids, p_list)
   WHERE workspace_id = p_workspace
     AND id = ANY (COALESCE(p_company_ids, '{}'::uuid[]))
     AND NOT (prospect_list_ids @> ARRAY[p_list]);

  UPDATE public.contact
     SET prospect_list_ids = array_append(prospect_list_ids, p_list)
   WHERE workspace_id = p_workspace
     AND id = ANY (COALESCE(p_contact_ids, '{}'::uuid[]))
     AND NOT (prospect_list_ids @> ARRAY[p_list]);
END;
$$;

CREATE OR REPLACE FUNCTION public.prospect_list_mark_unpublished(
  p_workspace uuid,
  p_list uuid,
  p_company_ids uuid[],
  p_contact_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.is_workspace_member(p_workspace) THEN
    RAISE EXCEPTION 'not a member of workspace %', p_workspace USING ERRCODE = '42501';
  END IF;

  UPDATE public.company
     SET prospect_list_ids = array_remove(prospect_list_ids, p_list)
   WHERE workspace_id = p_workspace
     AND id = ANY (COALESCE(p_company_ids, '{}'::uuid[]))
     AND prospect_list_ids @> ARRAY[p_list];

  UPDATE public.contact
     SET prospect_list_ids = array_remove(prospect_list_ids, p_list)
   WHERE workspace_id = p_workspace
     AND id = ANY (COALESCE(p_contact_ids, '{}'::uuid[]))
     AND prospect_list_ids @> ARRAY[p_list];
END;
$$;

REVOKE ALL ON FUNCTION public.prospect_list_mark_published(uuid, uuid, uuid[], uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.prospect_list_mark_unpublished(uuid, uuid, uuid[], uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prospect_list_mark_published(uuid, uuid, uuid[], uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prospect_list_mark_unpublished(uuid, uuid, uuid[], uuid[]) TO authenticated, service_role;
