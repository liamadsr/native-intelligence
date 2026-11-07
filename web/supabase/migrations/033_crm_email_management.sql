-- ============================================================
-- 033: CRM & Email Management
-- Adds contacts, companies, email thread indexing, and draft tables.
-- Bridges capture participants to CRM contacts.
-- ============================================================

-- ============================================================
-- 1. Company table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.company (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  name text NOT NULL,
  domain text,
  website text,
  industry text,
  description text,
  logo_url text,
  employee_count_range text,
  annual_revenue_range text,
  address text,
  city text,
  state text,
  country text,
  tags text[] DEFAULT '{}',
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  UNIQUE (workspace_id, domain)
);

CREATE INDEX IF NOT EXISTS company_workspace_idx ON public.company (workspace_id);
CREATE INDEX IF NOT EXISTS company_domain_idx ON public.company (workspace_id, domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS company_name_search_idx ON public.company USING gin (to_tsvector('english', name));

-- ============================================================
-- 2. Contact table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.contact (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  member_id uuid REFERENCES public.member (id) ON DELETE SET NULL,
  company_id uuid REFERENCES public.company (id) ON DELETE SET NULL,

  first_name text,
  last_name text,
  full_name text NOT NULL,
  email text,
  secondary_emails text[] DEFAULT '{}',
  phone text,
  avatar_url text,

  job_title text,
  department text,
  linkedin_url text,

  relationship_type text DEFAULT 'contact'
    CHECK (relationship_type IN ('contact', 'lead', 'customer', 'partner', 'vendor', 'internal')),
  relationship_strength text DEFAULT 'neutral'
    CHECK (relationship_strength IN ('strong', 'warm', 'neutral', 'cold', 'stale')),
  last_interaction_at timestamptz,
  interaction_count int DEFAULT 0,
  next_followup_at timestamptz,

  source text DEFAULT 'manual'
    CHECK (source IN ('manual', 'email_sync', 'calendar_sync', 'capture_participant', 'csv_import')),
  source_provider text,
  provider_contact_id text,

  notes text,
  tags text[] DEFAULT '{}',
  metadata jsonb DEFAULT '{}',

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  UNIQUE (workspace_id, email)
);

CREATE INDEX IF NOT EXISTS contact_workspace_idx ON public.contact (workspace_id);
CREATE INDEX IF NOT EXISTS contact_company_idx ON public.contact (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contact_member_idx ON public.contact (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contact_email_idx ON public.contact (workspace_id, email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS contact_last_interaction_idx ON public.contact (workspace_id, last_interaction_at DESC);
CREATE INDEX IF NOT EXISTS contact_name_search_idx ON public.contact USING gin (to_tsvector('english', full_name));
CREATE INDEX IF NOT EXISTS contact_relationship_type_idx ON public.contact (workspace_id, relationship_type);

-- FTS column for unified search
ALTER TABLE public.contact ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(full_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(email, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(notes, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS contact_fts_idx ON public.contact USING gin (fts);

-- ============================================================
-- 3. Contact interaction table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.contact_interaction (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contact (id) ON DELETE CASCADE,

  interaction_type text NOT NULL
    CHECK (interaction_type IN ('capture', 'email_sent', 'email_received', 'action_assigned', 'action_completed', 'note_added')),

  reference_type text CHECK (reference_type IN ('capture', 'email_thread', 'action', 'document')),
  reference_id text,

  title text,
  summary text,
  occurred_at timestamptz NOT NULL,

  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS interaction_contact_idx ON public.contact_interaction (contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS interaction_workspace_idx ON public.contact_interaction (workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS interaction_reference_idx ON public.contact_interaction (reference_type, reference_id);

-- ============================================================
-- 4. Link capture_participant to contact
-- ============================================================

ALTER TABLE public.capture_participant
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contact (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS capture_participant_contact_idx
  ON public.capture_participant (contact_id)
  WHERE contact_id IS NOT NULL;

-- ============================================================
-- 5. Email thread index table (metadata only, no bodies)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.email_thread_index (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  provider_thread_id text NOT NULL,
  provider_message_id text,

  subject text,
  snippet text,
  from_email text,
  from_name text,
  to_emails text[] DEFAULT '{}',
  cc_emails text[] DEFAULT '{}',
  participant_emails text[] DEFAULT '{}',

  message_count int DEFAULT 1,
  is_unread boolean DEFAULT true,
  is_starred boolean DEFAULT false,
  has_attachments boolean DEFAULT false,
  last_message_at timestamptz,

  needs_reply boolean DEFAULT false,
  auto_classified text
    CHECK (auto_classified IS NULL OR auto_classified IN ('newsletter', 'notification', 'personal', 'transactional', 'important')),

  linked_contact_id uuid REFERENCES public.contact (id) ON DELETE SET NULL,
  linked_capture_id uuid REFERENCES public.captures (id) ON DELETE SET NULL,
  linked_action_id uuid REFERENCES public.actions (id) ON DELETE SET NULL,
  linked_project_id uuid REFERENCES public.projects (id) ON DELETE SET NULL,

  synced_at timestamptz DEFAULT now(),
  history_id text,

  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  UNIQUE (workspace_id, user_id, provider_thread_id)
);

CREATE INDEX IF NOT EXISTS email_thread_workspace_user_idx ON public.email_thread_index (workspace_id, user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS email_thread_needs_reply_idx ON public.email_thread_index (workspace_id, user_id, needs_reply) WHERE needs_reply = true;
CREATE INDEX IF NOT EXISTS email_thread_contact_idx ON public.email_thread_index (linked_contact_id) WHERE linked_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_thread_participant_idx ON public.email_thread_index USING gin (participant_emails);
CREATE INDEX IF NOT EXISTS email_thread_classified_idx ON public.email_thread_index (workspace_id, user_id, auto_classified);
CREATE INDEX IF NOT EXISTS email_thread_subject_search_idx ON public.email_thread_index USING gin (to_tsvector('english', coalesce(subject, '')));

-- ============================================================
-- 6. Email draft table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.email_draft (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  email_thread_id uuid REFERENCES public.email_thread_index (id) ON DELETE SET NULL,
  provider_thread_id text,
  provider text CHECK (provider IS NULL OR provider IN ('google', 'microsoft')),

  subject text,
  to_emails text[] DEFAULT '{}',
  cc_emails text[] DEFAULT '{}',
  body_html text,
  body_text text,

  context_sources jsonb DEFAULT '{}',
  generation_prompt text,

  status text DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'edited', 'sent', 'dismissed')),

  provider_draft_id text,
  sent_at timestamptz,

  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_draft_user_status_idx ON public.email_draft (workspace_id, user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS email_draft_thread_idx ON public.email_draft (email_thread_id) WHERE email_thread_id IS NOT NULL;

-- ============================================================
-- 7. RLS policies
-- ============================================================

ALTER TABLE public.company ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_interaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_thread_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_draft ENABLE ROW LEVEL SECURITY;

-- Company: workspace members
CREATE POLICY "Workspace members can view companies"
  ON public.company FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace members can manage companies"
  ON public.company FOR ALL
  USING (public.is_workspace_member(workspace_id));

-- Contact: workspace members
CREATE POLICY "Workspace members can view contacts"
  ON public.contact FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace members can manage contacts"
  ON public.contact FOR ALL
  USING (public.is_workspace_member(workspace_id));

-- Contact interaction: workspace members
CREATE POLICY "Workspace members can view interactions"
  ON public.contact_interaction FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace members can manage interactions"
  ON public.contact_interaction FOR ALL
  USING (public.is_workspace_member(workspace_id));

-- Email threads: user-scoped
CREATE POLICY "Users can view their own email threads"
  ON public.email_thread_index FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own email threads"
  ON public.email_thread_index FOR ALL
  USING (auth.uid() = user_id);

-- Email drafts: user-scoped
CREATE POLICY "Users can view their own drafts"
  ON public.email_draft FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own drafts"
  ON public.email_draft FOR ALL
  USING (auth.uid() = user_id);

-- ============================================================
-- 8. Postgres helper functions
-- ============================================================

-- Update contact interaction stats
CREATE OR REPLACE FUNCTION public.update_contact_interaction_stats(
  p_contact_id uuid,
  p_occurred_at timestamptz
) RETURNS void AS $$
BEGIN
  UPDATE public.contact
  SET
    interaction_count = interaction_count + 1,
    last_interaction_at = GREATEST(last_interaction_at, p_occurred_at),
    updated_at = now()
  WHERE id = p_contact_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- List companies with stats
CREATE OR REPLACE FUNCTION public.list_companies_with_stats(
  p_workspace_id uuid,
  p_search text DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
) RETURNS TABLE (
  id uuid,
  name text,
  domain text,
  logo_url text,
  industry text,
  contact_count bigint,
  capture_count bigint,
  last_interaction_at timestamptz
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.domain,
    c.logo_url,
    c.industry,
    COUNT(DISTINCT ct.id) as contact_count,
    COUNT(DISTINCT cp.capture_id) as capture_count,
    MAX(ct.last_interaction_at) as last_interaction_at
  FROM public.company c
  LEFT JOIN public.contact ct ON ct.company_id = c.id
  LEFT JOIN public.capture_participant cp ON cp.contact_id = ct.id
  WHERE c.workspace_id = p_workspace_id
    AND (p_search IS NULL OR c.name ILIKE '%' || p_search || '%' OR c.domain ILIKE '%' || p_search || '%')
  GROUP BY c.id
  ORDER BY last_interaction_at DESC NULLS LAST
  LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get decisions by participant emails
CREATE OR REPLACE FUNCTION public.get_decisions_by_participant_emails(
  p_workspace_id uuid,
  p_emails text[],
  p_limit int DEFAULT 5
) RETURNS TABLE (
  id uuid,
  content text,
  capture_title text,
  confirmation text,
  created_at timestamptz
) AS $$
BEGIN
  RETURN QUERY
  SELECT d.id, d.content, cap.title as capture_title, d.confirmation, d.created_at
  FROM public.decision d
  JOIN public.captures cap ON cap.id = d.capture_id
  JOIN public.capture_participant cp ON cp.capture_id = cap.id
  WHERE cap.workspace_id = p_workspace_id
    AND cp.external_email = ANY(p_emails)
    AND d.confirmation = 'confirmed'
  ORDER BY d.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 9. Update unified_search to include contacts and companies
-- ============================================================

CREATE OR REPLACE FUNCTION public.unified_search(
  p_workspace_id uuid,
  p_query text,
  p_types text[] DEFAULT ARRAY['action', 'capture', 'document', 'project', 'decision', 'contact', 'company'],
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  result_type text,
  result_id uuid,
  title text,
  subtitle text,
  icon text,
  rank real,
  metadata jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tsquery tsquery;
BEGIN
  v_tsquery := websearch_to_tsquery('english', p_query);

  IF v_tsquery IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY

  -- Actions
  SELECT
    'action'::text AS result_type,
    a.id AS result_id,
    a.title,
    COALESCE(ws.name, '') AS subtitle,
    a.identifier AS icon,
    ts_rank(a.fts, v_tsquery) AS rank,
    jsonb_build_object(
      'identifier', a.identifier,
      'status_id', a.status_id,
      'status_name', ws.name,
      'priority', a.priority,
      'assignee_id', a.assignee_id,
      'team_id', a.team_id
    ) AS metadata
  FROM public.actions a
  JOIN public.team t ON t.id = a.team_id
  LEFT JOIN public.workflow_state ws ON ws.id = a.status_id
  WHERE t.workspace_id = p_workspace_id
    AND 'action' = ANY(p_types)
    AND a.fts @@ v_tsquery

  UNION ALL

  -- Captures
  SELECT
    'capture'::text,
    c.id,
    c.title,
    COALESCE(r.name, 'Capture') AS subtitle,
    COALESCE(r.icon, '') AS icon,
    ts_rank(c.fts, v_tsquery) AS rank,
    jsonb_build_object(
      'recipe_name', r.name,
      'recipe_icon', r.icon,
      'started_at', c.started_at,
      'duration_seconds', c.duration_seconds
    ) AS metadata
  FROM public.captures c
  LEFT JOIN public.recipe r ON r.id = c.recipe_id
  WHERE c.workspace_id = p_workspace_id
    AND 'capture' = ANY(p_types)
    AND c.fts @@ v_tsquery

  UNION ALL

  -- Documents
  SELECT
    'document'::text,
    d.id,
    d.title,
    'Document' AS subtitle,
    '' AS icon,
    ts_rank(d.fts, v_tsquery) AS rank,
    jsonb_build_object(
      'status', d.status,
      'project_id', d.project_id,
      'is_pinned', d.is_pinned
    ) AS metadata
  FROM public.document d
  WHERE d.workspace_id = p_workspace_id
    AND 'document' = ANY(p_types)
    AND d.fts @@ v_tsquery

  UNION ALL

  -- Projects
  SELECT
    'project'::text,
    p.id,
    p.name AS title,
    COALESCE(p.status::text, 'active') AS subtitle,
    '' AS icon,
    ts_rank(p.fts, v_tsquery) AS rank,
    jsonb_build_object(
      'status', p.status,
      'lead_id', p.lead_id
    ) AS metadata
  FROM public.projects p
  WHERE p.workspace_id = p_workspace_id
    AND 'project' = ANY(p_types)
    AND p.fts @@ v_tsquery

  UNION ALL

  -- Decisions
  SELECT
    'decision'::text,
    dec.id,
    LEFT(dec.content, 100) AS title,
    'Decision' AS subtitle,
    '' AS icon,
    ts_rank(dec.fts, v_tsquery) AS rank,
    jsonb_build_object(
      'capture_id', dec.capture_id,
      'confirmation', dec.confirmation,
      'project_id', dec.project_id
    ) AS metadata
  FROM public.decision dec
  JOIN public.captures c ON c.id = dec.capture_id
  WHERE c.workspace_id = p_workspace_id
    AND 'decision' = ANY(p_types)
    AND dec.fts @@ v_tsquery

  UNION ALL

  -- Contacts
  SELECT
    'contact'::text,
    ct.id,
    ct.full_name AS title,
    COALESCE(ct.email, '') || CASE WHEN ct.job_title IS NOT NULL THEN ' · ' || ct.job_title ELSE '' END ||
    CASE WHEN comp.name IS NOT NULL THEN ' @ ' || comp.name ELSE '' END AS subtitle,
    '' AS icon,
    ts_rank(ct.fts, v_tsquery) AS rank,
    jsonb_build_object(
      'email', ct.email,
      'company_name', comp.name,
      'job_title', ct.job_title,
      'relationship_type', ct.relationship_type
    ) AS metadata
  FROM public.contact ct
  LEFT JOIN public.company comp ON comp.id = ct.company_id
  WHERE ct.workspace_id = p_workspace_id
    AND 'contact' = ANY(p_types)
    AND (
      ct.fts @@ v_tsquery
      OR ct.full_name ILIKE '%' || p_query || '%'
      OR ct.email ILIKE '%' || p_query || '%'
    )

  UNION ALL

  -- Companies
  SELECT
    'company'::text,
    co.id,
    co.name AS title,
    COALESCE(co.domain, '') || CASE WHEN co.industry IS NOT NULL THEN ' · ' || co.industry ELSE '' END AS subtitle,
    '' AS icon,
    ts_rank(to_tsvector('english', co.name || ' ' || COALESCE(co.domain, '') || ' ' || COALESCE(co.description, '')), v_tsquery) AS rank,
    jsonb_build_object(
      'domain', co.domain,
      'industry', co.industry
    ) AS metadata
  FROM public.company co
  WHERE co.workspace_id = p_workspace_id
    AND 'company' = ANY(p_types)
    AND (
      to_tsvector('english', co.name || ' ' || COALESCE(co.domain, '') || ' ' || COALESCE(co.description, '')) @@ v_tsquery
      OR co.name ILIKE '%' || p_query || '%'
      OR co.domain ILIKE '%' || p_query || '%'
    )

  ORDER BY rank DESC
  LIMIT p_limit;
END;
$$;

-- ============================================================
-- 10. Update notification type constraint
-- ============================================================

ALTER TABLE public.notification DROP CONSTRAINT IF EXISTS notification_type_check;
ALTER TABLE public.notification ADD CONSTRAINT notification_type_check
  CHECK (type IN (
    'action_assigned',
    'action_unassigned',
    'action_status_changed',
    'action_priority_changed',
    'action_due_soon',
    'action_overdue',
    'action_mentioned',
    'capture_processed',
    'capture_shared',
    'comment_added',
    'comment_reply',
    'decision_confirmed',
    'cycle_started',
    'cycle_ending_soon',
    'share_comment_added',
    'project_status_changed',
    'meeting_starting_soon',
    'followup_reminder',
    'contact_followup_due',
    'relationship_going_stale',
    'email_drafts_ready'
  ));

-- Seed new notification preferences for existing members
INSERT INTO public.notification_preference (member_id, notification_type, in_app, email)
SELECT m.id, t.type, true, false
FROM public.member m
CROSS JOIN (VALUES
  ('contact_followup_due'),
  ('relationship_going_stale'),
  ('email_drafts_ready')
) AS t(type)
ON CONFLICT DO NOTHING;
