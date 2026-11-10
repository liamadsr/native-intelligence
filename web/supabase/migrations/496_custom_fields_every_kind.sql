-- ============================================================
-- 496: custom fields on any kind (the shared entity layer, phase 6).
-- ============================================================
-- 473 gave a workspace its own fields on deals, contacts and companies: one
-- definition table (custom_field_definition) and a `custom_fields` jsonb on
-- each record, keyed by the definition's key. Which kinds take fields is now
-- the entity registry's `customFields` flag
-- (src/lib/knowledge/entity-registry.ts); this widens the database to match:
--
--   1. custom_field_definition_entity_check lists every kind with the flag:
--      the three CRM kinds plus action (a task), project, initiative and
--      document. src/lib/crm/__tests__/migration-496.test.ts pins this list
--      to the flag.
--   2. actions, projects, initiative and document gain `custom_fields`
--      exactly as 473 added it to contact and company: jsonb, not null,
--      default '{}', CHECKed to be an object. The default is a constant, so
--      the column is added without rewriting the table; the CHECK is added
--      NOT VALID and validated separately, so the scan holds only a SHARE
--      UPDATE EXCLUSIVE lock.
--   3. company_visible_to_ungranted(company, user): company_visible_to
--      without its grant arm, the company twin of 495's
--      contact_visible_to_ungranted. The agent's set_custom_fields runs on a
--      service-role client and gated its company writes on
--      company_visible_to, which 493 widened with the grant arm: a member
--      who could only VIEW a company (a grant, or a grant on one of its
--      contacts) could have its agent set the company's fields. The write
--      gate asks this instead: an owner or admin, or a member who can see
--      one of its contacts without a grant.
--
-- Who may write a record's values is unchanged: each kind's own UPDATE
-- policy (and 494's restrictive ones) decides, since the values are a column
-- on the record. A view grant (492) never reaches a write: document_update
-- restates the read rule without the grant arm, contact_update keys on
-- can_edit_contact, company has 494's company_update_not_by_grant, and
-- actions, projects and initiatives take no grants. The values route reads
-- back the row it updated, so a refused write is a 403, never a silent
-- no-op; the service-role tools ask the same edit rule first
-- (src/lib/crm/custom-field-access.ts).
--
-- No new policies, no new grants: the new columns fall under each table's
-- existing table-level privileges, realtime publication and replica
-- identity (all four are already published, REPLICA IDENTITY FULL).
--
-- After 473 and 495. Idempotent (if not exists, drop constraint if exists,
-- create or replace). No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── 1. The kinds a definition may be on ─────────────────────────────────────
alter table public.custom_field_definition drop constraint if exists custom_field_definition_entity_check;
alter table public.custom_field_definition
  add constraint custom_field_definition_entity_check
  check (entity_type in ('document', 'contact', 'project', 'action', 'initiative', 'company', 'deal'));

comment on table public.custom_field_definition is
  'A workspace''s own fields on the kinds the entity registry marks customFields (473, 496). Values live in each record''s custom_fields jsonb under `key`.';

-- ── 2. Where the values live ────────────────────────────────────────────────
alter table public.actions add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table public.projects add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table public.initiative add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table public.document add column if not exists custom_fields jsonb not null default '{}'::jsonb;

alter table public.actions drop constraint if exists actions_custom_fields_object;
alter table public.actions
  add constraint actions_custom_fields_object check (jsonb_typeof(custom_fields) = 'object') not valid;
alter table public.actions validate constraint actions_custom_fields_object;

alter table public.projects drop constraint if exists projects_custom_fields_object;
alter table public.projects
  add constraint projects_custom_fields_object check (jsonb_typeof(custom_fields) = 'object') not valid;
alter table public.projects validate constraint projects_custom_fields_object;

alter table public.initiative drop constraint if exists initiative_custom_fields_object;
alter table public.initiative
  add constraint initiative_custom_fields_object check (jsonb_typeof(custom_fields) = 'object') not valid;
alter table public.initiative validate constraint initiative_custom_fields_object;

alter table public.document drop constraint if exists document_custom_fields_object;
alter table public.document
  add constraint document_custom_fields_object check (jsonb_typeof(custom_fields) = 'object') not valid;
alter table public.document validate constraint document_custom_fields_object;

-- ── 3. The company write gate, without the grant arm ────────────────────────
-- 495's company_visible_to, minus its grant arm, and asking each contact
-- through contact_visible_to_ungranted (a grant on a contact must not make
-- its company writable either).
create or replace function public.company_visible_to_ungranted(p_company_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
DECLARE
  v_workspace_id uuid;
  v_member_id    uuid;
  v_role         text;
BEGIN
  SELECT c.workspace_id INTO v_workspace_id
    FROM public.company c
   WHERE c.id = p_company_id;
  IF v_workspace_id IS NULL THEN RETURN FALSE; END IF;
  IF p_user_id IS NULL THEN RETURN FALSE; END IF;

  SELECT m.id, m.role INTO v_member_id, v_role
    FROM public.member m
   WHERE m.user_id = p_user_id AND m.workspace_id = v_workspace_id
   LIMIT 1;
  IF v_member_id IS NULL THEN RETURN FALSE; END IF;

  IF v_role IN ('owner','admin') THEN RETURN TRUE; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.contact ct
     WHERE ct.company_id = p_company_id
       AND ct.merged_into_contact_id IS NULL
       AND public.contact_visible_to_ungranted(ct.id, p_user_id)
  );
END
$function$;

revoke all on function public.company_visible_to_ungranted(uuid, uuid) from public, anon;
grant execute on function public.company_visible_to_ungranted(uuid, uuid) to authenticated, service_role;
