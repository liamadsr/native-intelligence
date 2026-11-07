-- ============================================================
-- 232: Auto-link contacts to companies by email domain
-- ============================================================
-- The People rollup: a contact with no explicit company whose email domain
-- matches a workspace company's domain belongs to that company. The provider
-- contact-sync path already does this in TS (src/lib/crm/contacts.ts, gated
-- by PERSONAL_DOMAINS), but extraction / manual / MCP creation paths don't —
-- so an unassigned jane@acme.com never appears on Acme's People tab.
-- Materialize the rule at the DB so EVERY creation path agrees, and every
-- surface (People tab, companies-list contact counts, cascade delete counts)
-- reads the same membership.
--
-- Rules:
--   * Explicit assignment always wins — only company_id IS NULL rows are
--     ever touched, and un-assigning a contact sticks: the contact trigger
--     bails unless the email VALUE actually changed (UPDATE OF alone fires
--     on column mention — the contact panel PATCHes an unchanged email on
--     every blur, which must not re-link).
--   * Freemail domains never link (mirror of PERSONAL_DOMAINS in
--     src/lib/crm/contact-dedup.ts — keep the two lists in sync).
--   * Teammate self-contacts (member_id set, ensureMemberContact) never
--     link: they are identity anchors carrying voice enrollments
--     (ON DELETE CASCADE), and linking them would put the team on their own
--     company's People tab — and inside its delete cascade.
--   * HubSpot-owned contacts (source_provider = 'hubspot') never link: the
--     provider's explicit association is applied only-when-null on sync
--     (hubspot-sync.ts buildContactPatch), so a domain guess here would
--     permanently block the true association.
--   * Contact side: BEFORE INSERT, or UPDATE that changes email.
--   * Company side: AFTER INSERT, or UPDATE that changes domain — adopts the
--     workspace's existing unassigned contacts with that domain, but only
--     when it is the workspace's canonical (oldest) company for that domain,
--     matching the contact trigger's pick.
--   * Every auto-link stamps metadata.company_autolinked = true, so derived
--     assignments stay mechanically distinguishable from deliberate ones
--     (bulk-undo / policy tuning stays possible).
--   * One-time backfill at the end links what already drifted.
--   * Primary email only — secondary_emails don't drive linking (same as the
--     TS sync path; dedup merge is the tool for multi-email identity).

CREATE OR REPLACE FUNCTION public.is_personal_email_domain(p_domain text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT lower(coalesce(p_domain, '')) = ANY (ARRAY[
    'gmail.com','googlemail.com','yahoo.com','hotmail.com','outlook.com',
    'icloud.com','aol.com','protonmail.com','proton.me','live.com','me.com',
    'mail.com','ymail.com','msn.com','zoho.com','fastmail.com','gmx.com'
  ])
$$;

-- SECURITY DEFINER is required, not a convenience: the company SELECT policy
-- (migration 059) hides contact-less companies from plain members, so an
-- invoker-rights trigger could fail to find the very company the contact
-- should link to. Both functions only touch rows in NEW's own workspace.
CREATE OR REPLACE FUNCTION public.contact_autolink_company()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_domain text;
  v_company_id uuid;
BEGIN
  -- Only a real email change may re-link (see header: UPDATE OF fires on
  -- column mention, and the UI round-trips unchanged emails on blur).
  IF TG_OP = 'UPDATE' AND NEW.email IS NOT DISTINCT FROM OLD.email THEN
    RETURN NEW;
  END IF;
  IF NEW.company_id IS NOT NULL
     OR NEW.email IS NULL
     OR NEW.member_id IS NOT NULL
     OR NEW.source_provider = 'hubspot' THEN
    RETURN NEW;
  END IF;
  v_domain := lower(split_part(NEW.email, '@', 2));
  IF v_domain = '' OR public.is_personal_email_domain(v_domain) THEN
    RETURN NEW;
  END IF;
  -- Duplicate domains resolve to the oldest company, deterministically —
  -- the adopt trigger and backfill below must pick the same one.
  SELECT id INTO v_company_id
  FROM public.company
  WHERE workspace_id = NEW.workspace_id
    AND lower(domain) = v_domain
  ORDER BY created_at, id
  LIMIT 1;
  IF v_company_id IS NOT NULL THEN
    NEW.company_id := v_company_id;
    NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb)
      || jsonb_build_object('company_autolinked', true);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_autolink_company_trigger ON public.contact;
CREATE TRIGGER contact_autolink_company_trigger
  BEFORE INSERT OR UPDATE OF email ON public.contact
  FOR EACH ROW
  EXECUTE FUNCTION public.contact_autolink_company();

CREATE OR REPLACE FUNCTION public.company_adopt_domain_contacts()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.domain IS NULL OR NEW.domain = ''
     OR public.is_personal_email_domain(NEW.domain) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.domain IS NOT DISTINCT FROM OLD.domain THEN
    RETURN NEW;
  END IF;
  -- Adopt only as the workspace's canonical (oldest) company for this
  -- domain — a newer case-variant duplicate must not split the rollup.
  IF NEW.id <> (
    SELECT id FROM public.company
    WHERE workspace_id = NEW.workspace_id
      AND lower(domain) = lower(NEW.domain)
    ORDER BY created_at, id
    LIMIT 1
  ) THEN
    RETURN NEW;
  END IF;
  UPDATE public.contact
  SET company_id = NEW.id,
      metadata = coalesce(metadata, '{}'::jsonb)
        || jsonb_build_object('company_autolinked', true),
      updated_at = now()
  WHERE workspace_id = NEW.workspace_id
    AND company_id IS NULL
    AND email IS NOT NULL
    AND member_id IS NULL
    AND (source_provider IS NULL OR source_provider <> 'hubspot')
    AND lower(split_part(email, '@', 2)) = lower(NEW.domain);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS company_adopt_domain_contacts_trigger ON public.company;
CREATE TRIGGER company_adopt_domain_contacts_trigger
  AFTER INSERT OR UPDATE OF domain ON public.company
  FOR EACH ROW
  EXECUTE FUNCTION public.company_adopt_domain_contacts();

-- ── Backfill ────────────────────────────────────────────────
-- Subquery (not UPDATE...FROM) so duplicate-domain workspaces resolve to the
-- same oldest-company pick as the triggers, deterministically.
UPDATE public.contact ct
SET company_id = (
      SELECT c.id
      FROM public.company c
      WHERE c.workspace_id = ct.workspace_id
        AND c.domain IS NOT NULL
        AND lower(c.domain) = lower(split_part(ct.email, '@', 2))
      ORDER BY c.created_at, c.id
      LIMIT 1
    ),
    metadata = coalesce(ct.metadata, '{}'::jsonb)
      || jsonb_build_object('company_autolinked', true),
    updated_at = now()
WHERE ct.company_id IS NULL
  AND ct.email IS NOT NULL
  AND ct.member_id IS NULL
  AND (ct.source_provider IS NULL OR ct.source_provider <> 'hubspot')
  AND split_part(ct.email, '@', 2) <> ''
  AND NOT public.is_personal_email_domain(lower(split_part(ct.email, '@', 2)))
  AND EXISTS (
    SELECT 1
    FROM public.company c2
    WHERE c2.workspace_id = ct.workspace_id
      AND c2.domain IS NOT NULL
      AND lower(c2.domain) = lower(split_part(ct.email, '@', 2))
  );
