-- Migration 266: `candidate` joins contact.relationship_type.
--
-- Part of "anchors are configuration": role→anchor wiring makes Recruiting a
-- first-class onboarding role, and a recruiter's CRM is full of people who are
-- neither a lead nor a customer nor an internal teammate. `candidate` is the
-- missing arm.
--
-- The value list is the FULL intended set, not a delta: the constraint is
-- dropped and re-added wholesale, so every existing value has to travel with
-- the change. The app-side copies that must match it are
--   - src/lib/views/types.ts (the property-editor enum, and therefore the CRM
--     detail-panel select and the bulk-edit picker),
--   - src/lib/ai/tools/contacts.ts (list_contacts' zod enum),
--   - contact-detail-panel.tsx's TYPE_CONFIG (the human-readable label).
-- Nothing checks these automatically; a value added here without them is
-- writable by the API and invisible in the UI.
--
-- The constraint is found BY DEFINITION rather than by name: 033 created it
-- inline on the column, so Postgres picked the name, and a hardcoded name would
-- silently no-op on any database where it differs.

DO $$
DECLARE
  conname_var TEXT;
BEGIN
  SELECT con.conname INTO conname_var
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'contact'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%relationship_type %IN%'
  ORDER BY con.conname
  LIMIT 1;

  IF conname_var IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.contact DROP CONSTRAINT %I', conname_var);
  END IF;

  ALTER TABLE public.contact DROP CONSTRAINT IF EXISTS contact_relationship_type_check;

  ALTER TABLE public.contact
    ADD CONSTRAINT contact_relationship_type_check CHECK (relationship_type IN (
      'contact', 'lead', 'customer', 'partner', 'vendor', 'internal',
      'candidate'
    ));
END $$;
