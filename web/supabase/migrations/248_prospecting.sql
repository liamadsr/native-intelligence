-- 248_prospecting.sql
--
-- Prospecting: a top-level list surface (sibling of CRM and Sequences) where a
-- user builds a list — "Investors", "Companies with big sales teams" — and
-- Dial8 fills it with verified companies and the people at them, ready to drop
-- into a sequence.
--
-- THE load-bearing decision this schema encodes (spec §1, decision 1):
-- **a candidate is not a CRM record until you save it.** `prospect_list_entry`
-- carries the candidate identity itself — name, domain, LinkedIn URL, title —
-- in its `candidate` jsonb column, and `company_id` / `contact_id` stay NULL
-- until the user presses Save. Save is *promotion*: that is the moment a row
-- enters public.company / public.contact. Consequences that show up below:
--
--   * `candidate_key` on the ENTRY is the identity, not `company.domain` /
--     `contact.email`. That is what gives an emailless person (a LinkedIn URL
--     and nothing else — the common case) a durable home, and what makes
--     UNIQUE (list_id, candidate_key) the dedup guarantee even under a
--     concurrent double-run.
--   * `company_id` / `contact_id` are ON DELETE SET NULL, never CASCADE. The
--     entry IS the suppression set: one deleteCompaniesWithContacts() call
--     must not silently wipe dozens of dismissals across many lists and
--     re-open every one of them for re-discovery and re-billing. The entry
--     survives the CRM row and its candidate_key keeps suppressing.
--   * There is deliberately NO `lifecycle` column on public.company. Discovered
--     companies never reach that table before Save, so the fourteen
--     company-reading surfaces (list_companies_with_stats, unified_search, the
--     HubSpot push, the cron enrichment sweep, merge_contacts(), contact-dedup)
--     need no filter and carry no permanent leak risk.
--   * `'contacted'` is NOT a stage. It is derived at read time from
--     sequence_enrollment and rendered as a "Sequenced" chip — a column here
--     would drift the moment anyone enrolled a contact from the CRM, the
--     sequence detail page, or the enroll_contacts_in_sequence AI tool, none of
--     which know about entries.
--
-- Ordering note: prospect_list_entry references prospecting_run
-- (discovered_by_run_id) and prospecting_run references prospect_list, so the
-- entry table is created first WITHOUT that FK and the constraint is added
-- after prospecting_run exists (section 4).

-- ============================================================
-- 1. prospect_list — the list object, one row per purpose
-- ============================================================

CREATE TABLE public.prospect_list (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  description           text,
  -- `purpose` seeds the ICP draft and selects angle templates. It does NOT
  -- branch the pipeline — one code path, so a user can invent a purpose we
  -- never anticipated ("podcast hosts in our space") and it just works.
  purpose               text NOT NULL DEFAULT 'buyers'
                          CHECK (purpose IN ('buyers','investors','partners','talent','custom')),
  -- Prose-shaped, not filter-shaped: Exa deep search consumes a query string
  -- and a systemPrompt, so every structured filter would be flattened back to
  -- prose before the call. Shape in src/lib/prospecting/types.ts (Icp).
  icp                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  icp_version           integer NOT NULL DEFAULT 1,
  source_company_id     uuid REFERENCES public.company(id) ON DELETE SET NULL,

  -- exclusion policy (§6)
  exclude_crm           boolean NOT NULL DEFAULT true,
  exclude_other_lists   boolean NOT NULL DEFAULT false,
  -- TRI-STATE, not a boolean, and that is a product decision. enrollContacts'
  -- own already_active check filters status='active' (src/lib/sequences/
  -- mutations.ts), so a contact who exited a sequence twelve months ago is
  -- re-enrollable there. Hardcoding 'ever' here would permanently hide the
  -- entire re-engagement segment. Default 'ever' (a list is for NEW people),
  -- with 'active' available for a re-engagement list.
  exclude_contacted     text NOT NULL DEFAULT 'ever'
                          CHECK (exclude_contacted IN ('off','active','ever')),

  -- cost policy (§9)
  max_spend_dollars     numeric(10,4) NOT NULL DEFAULT 2.0000,
  target_new_candidates integer NOT NULL DEFAULT 20 CHECK (target_new_candidates BETWEEN 5 AND 100),
  max_rounds            integer NOT NULL DEFAULT 2 CHECK (max_rounds BETWEEN 1 AND 3),
  people_per_company    integer NOT NULL DEFAULT 3 CHECK (people_per_company BETWEEN 0 AND 10),

  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX prospect_list_workspace_name_idx
  ON public.prospect_list (workspace_id, lower(name));
CREATE INDEX prospect_list_workspace_status_idx
  ON public.prospect_list (workspace_id, status);

-- ============================================================
-- 2. prospect_list_entry — the candidate itself
-- ============================================================

CREATE TABLE public.prospect_list_entry (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  list_id            uuid NOT NULL REFERENCES public.prospect_list(id) ON DELETE CASCADE,

  kind               text NOT NULL CHECK (kind IN ('company','person')),

  -- THE identity, produced by src/lib/prospecting/keys.ts BEFORE any
  -- comparison. Companies: normalizeDomain() output — the same function
  -- company.domain's uniqueness relies on, so the set difference is exact
  -- rather than approximate. People: 'linkedin.com/in/<slug>' via
  -- normalizeLinkedInProfileUrl(), else lower(email), else
  -- lower(name)||'@'||domain SCOPED TO THE CANDIDATE ACCOUNT — never
  -- workspace-global, because two people with the same name at two companies
  -- are two people. A candidate that cannot produce a key is `invalid` and
  -- never becomes a row.
  candidate_key      text NOT NULL,
  -- { name, domain, linkedin_url, email, title, seniority, one_liner,
  --   exa_entity_id, found_via: 'synthesized' | 'result_entity' }
  candidate          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- NULL until Save. SET NULL, never cascade: the entry IS the suppression set.
  company_id         uuid REFERENCES public.company(id) ON DELETE SET NULL,
  contact_id         uuid REFERENCES public.contact(id) ON DELETE SET NULL,
  parent_entry_id    uuid REFERENCES public.prospect_list_entry(id) ON DELETE CASCADE,

  stage              text NOT NULL DEFAULT 'discovered'
                       CHECK (stage IN ('discovered','shortlisted','saved','dismissed')),

  -- 'anchored' = at least one field survived demoteUnrelatedPersonSources at
  -- high/medium against the company domain; 'needs_review' rows are excluded
  -- from bulk save and require a per-row confirm (the Devin Marsh namesake
  -- incident reproduces at 20x scale in a bulk pipeline).
  identity_state     text NOT NULL DEFAULT 'resolved'
                       CHECK (identity_state IN ('resolved','unresolved','anchored','needs_review')),

  -- Fit lives on the ENTRY, never on company: the same company scores
  -- differently against Investors than against Big-sales-teams.
  fit_tier           text CHECK (fit_tier IN ('A','B','C','D')),
  fit_score          integer CHECK (fit_score BETWEEN 0 AND 100),
  fit_signals        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{label, met, evidence_url}]
  fit_rationale      text,
  -- A real column because grounding is genuinely mixed: whyMatch,
  -- employeeRange and signal come back medium/low about half the time, and a
  -- rationale presented with the same visual confidence as a verified fact
  -- would be dishonest.
  fit_confidence     text CHECK (fit_confidence IN ('high','medium','low')),

  dismissed_reason   text CHECK (dismissed_reason IN
                       ('not_icp','too_small','too_big','competitor','already_customer','no_contact','other')),
  dismissed_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  dismissed_at       timestamptz,

  icp_version        integer NOT NULL DEFAULT 1,
  -- FK added in section 4 (prospecting_run does not exist yet).
  discovered_by_run_id uuid,
  -- Cheap telemetry that is unavailable retroactively: after a few weeks you
  -- can see which angles actually produce saved contacts.
  discovery_angle    text,
  -- SAME SHAPE as company.metadata.enrichment.fields, deliberately, so
  -- promotion merges it into the real row with the existing discipline
  -- (columnCandidates → computeFillEmptyPatch + mergeBlobFields) and
  -- readBlob / DetailField / isUnverified render it with zero new code.
  research           jsonb NOT NULL DEFAULT '{}'::jsonb,
  sources            jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospect_entry_kind_target CHECK (
    (kind = 'company' AND contact_id IS NULL)
    OR (kind = 'person' AND company_id IS NULL)
  )
);

-- The dedup guarantee. A 23505 here is caught by the run engine and mapped to
-- suppressed_by='this_list' rather than surfacing as an error.
CREATE UNIQUE INDEX prospect_entry_key_idx
  ON public.prospect_list_entry (list_id, candidate_key);
CREATE INDEX prospect_entry_ws_key_idx
  ON public.prospect_list_entry (workspace_id, candidate_key);
CREATE INDEX prospect_entry_list_stage_idx
  ON public.prospect_list_entry (list_id, stage);
CREATE INDEX prospect_entry_parent_idx
  ON public.prospect_list_entry (parent_entry_id) WHERE parent_entry_id IS NOT NULL;
CREATE INDEX prospect_entry_company_idx
  ON public.prospect_list_entry (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX prospect_entry_contact_idx
  ON public.prospect_list_entry (contact_id) WHERE contact_id IS NOT NULL;

-- ============================================================
-- 3. prospecting_run
-- ============================================================

CREATE TABLE public.prospecting_run (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  list_id            uuid NOT NULL REFERENCES public.prospect_list(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('discover','account_card','people')),
  -- Per-list and monotonic, so rounds accumulate across days: the second run
  -- of a list two weeks later is a CONTINUATION, not a repeat.
  round_index        integer NOT NULL DEFAULT 1,

  -- The AgentRunStatus vocabulary (src/lib/agent-run/types.ts) MINUS 'pr_open'
  -- (coding-run only) PLUS 'budget_exhausted' (§9). The divergence is
  -- deliberate and otherwise silent — a test pins it. isAgentRunLive still
  -- applies to the shared values, so the poll's isLive(status) gate is the
  -- same predicate.
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN
                       ('queued','running','needs_input','canceling','completed','failed','canceled','budget_exhausted')),
  stage              text NOT NULL DEFAULT 'discover'
                       CHECK (stage IN ('discover','score','account_card','people','done')),

  -- The ICP AS RUN. `prospect_list.icp_version` says entries drifted; this
  -- says what was actually searched. Both are needed.
  icp_snapshot       jsonb NOT NULL,
  target_entry_ids   uuid[],

  budget_dollars     numeric(10,4) NOT NULL,
  spent_dollars      numeric(10,6) NOT NULL DEFAULT 0,
  exa_calls          integer NOT NULL DEFAULT 0,

  -- Typed in src/lib/prospecting/types.ts as ProspectingRunProgress /
  -- ProspectingRunCounts / ExclusionSnapshot. These three are the interface
  -- between the Inngest writer and the polling UI, and untyped jsonb here
  -- produces a permanently blank progress bar that no test catches.
  progress           jsonb NOT NULL DEFAULT '{}'::jsonb,
  counts             jsonb NOT NULL DEFAULT '{}'::jsonb,
  exclusion_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,

  error              text,
  started_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- A second Find on the same list is refused BY THE DATABASE, not by a
-- race-prone application check. Inngest's concurrency key serializes
-- EXECUTION but not ENQUEUEING, so two presses of Find created two run rows
-- and the second still billed 4 discovery searches to find nothing. The
-- kickoff route maps 23505 to a 409 "already running" (the CAS-claim pattern
-- in /api/account/onboarding/research is the in-repo precedent).
CREATE UNIQUE INDEX prospecting_run_one_live_per_list
  ON public.prospecting_run (list_id) WHERE status IN ('queued','running');
CREATE INDEX prospecting_run_live_idx ON public.prospecting_run (workspace_id)
  WHERE status IN ('queued','running');
-- The monthly workspace ceiling (decision 5) sums spent_dollars for the
-- calendar month in preflight — no new table, but it needs this index.
CREATE INDEX prospecting_run_workspace_created_idx
  ON public.prospecting_run (workspace_id, created_at DESC);
CREATE INDEX prospecting_run_list_round_idx
  ON public.prospecting_run (list_id, round_index DESC);

-- ============================================================
-- 4. The deferred FK: entry → run
-- ============================================================
-- SET NULL, not CASCADE: pruning or losing a run must never delete the
-- entries it discovered — they are the suppression set.

ALTER TABLE public.prospect_list_entry
  ADD CONSTRAINT prospect_list_entry_discovered_by_run_id_fkey
  FOREIGN KEY (discovered_by_run_id)
  REFERENCES public.prospecting_run(id) ON DELETE SET NULL;

CREATE INDEX prospect_entry_run_idx
  ON public.prospect_list_entry (discovered_by_run_id)
  WHERE discovered_by_run_id IS NOT NULL;

-- ============================================================
-- 5. prospect_run_candidate — the transparency table
-- ============================================================
-- Every candidate a round saw, INCLUDING the ones it suppressed. This is what
-- makes dedup trustworthy: a dedup that silently drops repeats is
-- indistinguishable from a search that found nothing. The UI's collapsed
-- "17 skipped" row expands into these, grouped by reason, each linking to the
-- record that caused it.

CREATE TABLE public.prospect_run_candidate (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  run_id           uuid NOT NULL REFERENCES public.prospecting_run(id) ON DELETE CASCADE,
  list_id          uuid NOT NULL REFERENCES public.prospect_list(id) ON DELETE CASCADE,

  identity_key     text NOT NULL,
  display_name     text,
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovery_angle  text,

  outcome          text NOT NULL CHECK (outcome IN ('new','suppressed','invalid')),
  suppressed_by    text CHECK (suppressed_by IN
                     ('this_list','crm','other_list','dismissed_global','contacted',
                      'opted_out','personal_domain','self')),
  -- The CRM record or entry that caused the suppression, so the UI can link to it.
  suppressed_ref_id uuid,
  entry_id         uuid REFERENCES public.prospect_list_entry(id) ON DELETE SET NULL,

  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX prospect_run_candidate_key_idx
  ON public.prospect_run_candidate (run_id, identity_key);
CREATE INDEX prospect_run_candidate_list_idx
  ON public.prospect_run_candidate (list_id, created_at DESC);
-- Retention: /api/cron/prospecting-prune deletes rows whose run is terminal
-- and older than 90 days. Entry rows are NEVER pruned — they are the
-- suppression set.
CREATE INDEX prospect_run_candidate_run_idx
  ON public.prospect_run_candidate (run_id);

-- ============================================================
-- 6. RLS — workspace-member read/insert/update on all four tables,
--    creator-or-admin delete on prospect_list (227's pattern + 191's
--    creator-or-admin gate). The run engine is service-role and bypasses
--    these entirely, so every service-role bulk operation must carry an
--    explicit workspace check in application code (the rule documented at
--    the top of src/lib/crm/delete-companies.ts).
-- ============================================================

ALTER TABLE public.prospect_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_list_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospecting_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_run_candidate ENABLE ROW LEVEL SECURITY;

-- prospect_list: SELECT/INSERT/UPDATE for any member; DELETE only for the
-- creator or an owner/admin. Deleting a list cascades every entry, and the
-- entries are the workspace's accumulated suppression set — that is not a
-- thing any member should be able to throw away for everyone.
CREATE POLICY prospect_list_member_select ON public.prospect_list
  FOR SELECT USING (public.is_workspace_member(workspace_id));

CREATE POLICY prospect_list_member_insert ON public.prospect_list
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY prospect_list_member_update ON public.prospect_list
  FOR UPDATE
  USING (public.is_workspace_member(workspace_id))
  -- workspace_id pinned to the PRE-image so an UPDATE can never relocate a
  -- row across workspaces (191's trap: a member of two workspaces would
  -- otherwise pass every clause for both the old and a new workspace_id).
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND workspace_id = (SELECT l.workspace_id FROM public.prospect_list l WHERE l.id = prospect_list.id)
  );

CREATE POLICY prospect_list_creator_or_admin_delete ON public.prospect_list
  FOR DELETE USING (
    public.is_workspace_member(workspace_id)
    AND (
      created_by = auth.uid()
      OR public.get_member_role(workspace_id) IN ('owner', 'admin')
    )
  );

-- Entries carry their own workspace_id (they outlive their CRM rows and are
-- read by the exclusion set workspace-wide), so membership is checked
-- directly rather than riding the parent list.
CREATE POLICY prospect_list_entry_member_select ON public.prospect_list_entry
  FOR SELECT USING (public.is_workspace_member(workspace_id));

CREATE POLICY prospect_list_entry_member_insert ON public.prospect_list_entry
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY prospect_list_entry_member_update ON public.prospect_list_entry
  FOR UPDATE
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND workspace_id = (SELECT e.workspace_id FROM public.prospect_list_entry e WHERE e.id = prospect_list_entry.id)
  );

-- No client DELETE policy on entries, deliberately: an entry is the
-- suppression record. "Remove from list" is stage='dismissed', which keeps
-- suppressing. Entries go away only with their list (ON DELETE CASCADE).

CREATE POLICY prospecting_run_member_select ON public.prospecting_run
  FOR SELECT USING (public.is_workspace_member(workspace_id));

CREATE POLICY prospecting_run_member_insert ON public.prospecting_run
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));

-- Members may cancel a run (status → 'canceling'); the engine writes
-- everything else service-role.
CREATE POLICY prospecting_run_member_update ON public.prospecting_run
  FOR UPDATE
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND workspace_id = (SELECT r.workspace_id FROM public.prospecting_run r WHERE r.id = prospecting_run.id)
  );

-- The candidate ledger is engine-written and read-only from the client — it
-- is an audit trail, and a client that could edit it could hide a suppression.
CREATE POLICY prospect_run_candidate_member_select ON public.prospect_run_candidate
  FOR SELECT USING (public.is_workspace_member(workspace_id));

REVOKE ALL ON public.prospect_list, public.prospect_list_entry,
  public.prospecting_run, public.prospect_run_candidate FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prospect_list TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.prospect_list_entry TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.prospecting_run TO authenticated;
GRANT SELECT ON public.prospect_run_candidate TO authenticated;

-- ============================================================
-- 7. updated_at triggers (227 section 8's pattern)
-- ============================================================
-- Without these the column is write-once and lies forever.
-- prospect_run_candidate is append-only and has no updated_at.

CREATE TRIGGER prospect_list_updated_at
  BEFORE UPDATE ON public.prospect_list
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER prospect_list_entry_updated_at
  BEFORE UPDATE ON public.prospect_list_entry
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- prospecting_run has no updated_at column (started_at / finished_at carry the
-- lifecycle), so no trigger. Listed here so its absence reads as deliberate.

-- ============================================================
-- 8. company.is_workspace_company — "our own company", made explicit
-- ============================================================
-- Resolving the source company was a pure heuristic. This makes it a column,
-- with a partial unique index enforcing at most one per workspace.
--
-- NOTE: no `lifecycle` column. Discovered companies never reach this table
-- before Save (see the header).

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS is_workspace_company boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX company_one_workspace_company_idx
  ON public.company (workspace_id) WHERE is_workspace_company;

-- Backfill in the RESOLVER'S ORDER, and that ordering is load-bearing.
-- resolveSourceCompany (src/lib/prospecting/source-company.ts) prefers the
-- owner's self-contact's company_id over the owner's email-domain company,
-- because that is what onboarding links first (/api/internal/crm-enrichment
-- links the caller's self-contact to the created company when it has no
-- company yet). Backfilling by email domain ALONE while the runtime resolver
-- prefers the self-contact means that on exactly the workspaces the ordering
-- exists to handle — the owner's self-contact manually re-linked to a
-- different company — the backfill sets the flag on one row and step 1 then
-- wins forever, permanently mis-seeding every ICP in the workspace.
--
-- "The owner" is the workspace's oldest member with role='owner' (there is no
-- workspace.owner_id column). DISTINCT ON picks exactly one company per
-- workspace, so the partial unique index above cannot be violated.

WITH ws_owner AS (
  SELECT DISTINCT ON (m.workspace_id)
    m.workspace_id,
    m.id      AS member_id,
    m.user_id AS user_id
  FROM public.member m
  WHERE m.role = 'owner'
  ORDER BY m.workspace_id, m.created_at, m.id
),
resolved AS (
  SELECT DISTINCT ON (o.workspace_id)
    o.workspace_id,
    c.id AS company_id
  FROM ws_owner o
  -- Each branch is PARENTHESISED: a bare ORDER BY / LIMIT inside a UNION ALL
  -- arm binds to the whole union in Postgres, which would silently collapse
  -- the two steps into one arbitrary pick and defeat the ordering this block
  -- exists for.
  LEFT JOIN LATERAL (
    -- Step 2 (priority 1): the owner's self-contact's company — what
    -- onboarding links first.
    (
      SELECT ct.company_id, 1 AS step_rank
      FROM public.contact ct
      WHERE ct.member_id = o.member_id
        AND ct.company_id IS NOT NULL
        AND ct.merged_into_contact_id IS NULL
      ORDER BY ct.created_at, ct.id
      LIMIT 1
    )
    UNION ALL
    -- Step 3 (priority 2): the company matching the owner's email domain.
    -- Freemail domains are excluded — is_personal_email_domain() (mig 232) is
    -- the SQL twin of PERSONAL_DOMAINS / companyDomainFromEmail().
    (
      SELECT c2.id, 2 AS step_rank
      FROM auth.users u
      JOIN public.company c2
        ON c2.workspace_id = o.workspace_id
       AND c2.domain IS NOT NULL
       AND lower(c2.domain) = lower(split_part(u.email, '@', 2))
      WHERE u.id = o.user_id
        AND u.email IS NOT NULL
        AND split_part(u.email, '@', 2) <> ''
        AND NOT public.is_personal_email_domain(lower(split_part(u.email, '@', 2)))
      ORDER BY c2.created_at, c2.id
      LIMIT 1
    )
  ) pick ON true
  JOIN public.company c
    ON c.id = pick.company_id
   AND c.workspace_id = o.workspace_id
  ORDER BY o.workspace_id, pick.step_rank, c.created_at, c.id
)
UPDATE public.company c
SET is_workspace_company = true
FROM resolved r
WHERE c.id = r.company_id;

-- ============================================================
-- 9. contact.source — honest provenance for promoted prospects
-- ============================================================
-- The CHECK has been rebuilt twice (091, then 210); 210_hubspot_crm_integration
-- .sql is the CURRENT definition and this rebuilds from THAT list. Omitting
-- 'member' (written by ensureMemberContact for every workspace member's
-- self-contact) would fail immediately on any real database.

ALTER TABLE public.contact DROP CONSTRAINT IF EXISTS contact_source_check;
ALTER TABLE public.contact ADD CONSTRAINT contact_source_check
  CHECK (source IN ('manual', 'email_sync', 'calendar_sync', 'capture_participant',
                    'csv_import', 'member', 'hubspot_sync', 'prospecting'));

-- ============================================================
-- 10. merge_contacts() learns about prospect entries
-- ============================================================
-- 132_contact_dedup_merge.sql's merge_contacts() repoints six dependent tables
-- (capture_participant, contact_interaction, email_thread_index,
-- voice_enrollment, comment, contact_share). prospect_list_entry is the
-- seventh: without the repoint, merging a duplicate contact strands its entry
-- pointing at a tombstone, and the CRM exclusion rule stops recognising the
-- person.
--
-- The collision case is real — both contacts may sit in the SAME list, and
-- UNIQUE (list_id, candidate_key) is on the key, not on contact_id, so two
-- entries in one list can legitimately both carry a contact_id. The
-- survivor's entry wins; the loser's is deleted, but its DISMISSAL is
-- preserved first: if EITHER entry was dismissed, the survivor's entry stays
-- dismissed, so a merge can never resurrect a company or person the user
-- already rejected. The loser's `research` blob is folded in by the
-- application (the RPC keeps the SQL simple).
--
-- unmerge_contacts() (132, the undo path) does NOT restore a deleted entry.
-- That is an accepted loss: the survivor's entry still carries the same
-- candidate_key and keeps suppressing, so nothing becomes re-discoverable.
--
-- BASE: this body is 227_sequences.sql:523-680 verbatim — NOT 132's. 227 is the
-- CURRENT definition of merge_contacts() and adds two sequence_enrollment
-- blocks (the exit-instead-of-repoint collision guard and the repoint) on top
-- of 132's six repoints. Rebasing on 132 would silently delete them and strand
-- or duplicate-key every enrollment on a later merge. 248 adds ONLY the
-- prospect_list_entry blocks and the `prospect_list_entry_ids` key in v_moved.
-- The next author must rebase on THIS file, and keep every earlier block.

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
      COALESCE((SELECT jsonb_agg(id) FROM public.contact_share WHERE contact_id = p_source), '[]'::jsonb),
    -- Snapshot for the audit trail only — unmerge does not restore entries.
    'prospect_list_entry_ids',
      COALESCE((SELECT jsonb_agg(id) FROM public.prospect_list_entry WHERE contact_id = p_source), '[]'::jsonb)
  );

  -- Repoint every reference onto the surviving target.
  UPDATE public.capture_participant SET contact_id = p_target WHERE contact_id = p_source;
  UPDATE public.contact_interaction SET contact_id = p_target WHERE contact_id = p_source;
  UPDATE public.email_thread_index SET linked_contact_id = p_target WHERE linked_contact_id = p_source;
  UPDATE public.voice_enrollment SET contact_id = p_target WHERE contact_id = p_source;
  UPDATE public.comment SET commentable_id = p_target
    WHERE commentable_type = 'contact' AND commentable_id = p_source;
  UPDATE public.contact_share SET contact_id = p_target WHERE contact_id = p_source;

  -- 227: sequence enrollments. Exit-instead-of-repoint for active loser rows
  -- that would collide with the survivor (minds BOTH the pair
  -- UNIQUE(sequence_id, contact_id) and the one-active-per-contact /
  -- one-active-per-lower(email) partial uniques); then repoint whatever the
  -- pair slot allows. These read v_target.email, so they must run before the
  -- email rebuild below.
  UPDATE public.sequence_enrollment se
  SET status = 'exited', exit_reason = 'removed', next_send_at = NULL
  WHERE se.contact_id = p_source
    AND se.status = 'active'
    AND (
      EXISTS (
        SELECT 1 FROM public.sequence_enrollment t
        WHERE t.sequence_id = se.sequence_id AND t.contact_id = p_target
      )
      OR EXISTS (
        SELECT 1 FROM public.sequence_enrollment t
        WHERE t.workspace_id = se.workspace_id
          AND t.status = 'active'
          AND (
            t.contact_id = p_target
            OR (v_target.email IS NOT NULL AND lower(t.contact_email) = lower(v_target.email))
          )
      )
    );

  UPDATE public.sequence_enrollment se
  SET contact_id = p_target
  WHERE se.contact_id = p_source
    AND NOT EXISTS (
      SELECT 1 FROM public.sequence_enrollment t
      WHERE t.sequence_id = se.sequence_id AND t.contact_id = p_target
    );

  -- Prospecting entries (added by 248). Order matters:
  --   a) carry a dismissal FORWARD onto the survivor's entry, so a merge can
  --      never un-dismiss a rejected person;
  --   b) repoint the loser's entry only where the survivor has no entry in
  --      that same list;
  --   c) delete whatever is left pointing at the source — the same-list
  --      collision case.
  UPDATE public.prospect_list_entry t
  SET stage            = 'dismissed',
      dismissed_reason = COALESCE(t.dismissed_reason, s.dismissed_reason, 'other'),
      dismissed_by     = COALESCE(t.dismissed_by, s.dismissed_by),
      dismissed_at     = COALESCE(t.dismissed_at, s.dismissed_at, now()),
      updated_at       = now()
  FROM public.prospect_list_entry s
  WHERE t.contact_id = p_target
    AND s.contact_id = p_source
    AND s.list_id = t.list_id
    AND s.stage = 'dismissed'
    AND t.stage <> 'dismissed';

  UPDATE public.prospect_list_entry
  SET contact_id = p_target,
      updated_at = now()
  WHERE contact_id = p_source
    AND NOT EXISTS (
      SELECT 1 FROM public.prospect_list_entry e2
      WHERE e2.list_id = prospect_list_entry.list_id
        AND e2.contact_id = p_target
    );

  DELETE FROM public.prospect_list_entry WHERE contact_id = p_source;

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

REVOKE EXECUTE ON FUNCTION public.merge_contacts(uuid, uuid, text, numeric, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_contacts(uuid, uuid, text, numeric, jsonb, text) TO service_role;
