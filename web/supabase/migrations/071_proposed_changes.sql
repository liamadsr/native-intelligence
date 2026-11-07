-- Proposed changes: universal staging layer for AI-proposed workspace mutations
-- The AI keeps a to-do list as it processes meetings. Each row is one thing that needs to happen.
-- The UI renders these inline in the meeting summary. Users review, edit, and apply.

CREATE TABLE proposed_change (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  capture_id      UUID NOT NULL REFERENCES captures(id) ON DELETE CASCADE,

  -- What to do
  change_type     TEXT NOT NULL CHECK (change_type IN (
    'create', 'update', 'delete', 'assign', 'send_email'
  )),
  entity_type     TEXT NOT NULL CHECK (entity_type IN (
    'action', 'project', 'decision', 'milestone', 'initiative', 'contact'
  )),
  entity_id       UUID,           -- Target entity for update/delete/assign (null for create)

  -- Human-readable summary (what the user sees)
  display_text    TEXT NOT NULL,  -- e.g. "Sarah to update API docs by April 5"

  -- Shared fields across entity types (AI fills what's relevant, rest is null)
  title           TEXT,
  description     TEXT,
  priority        TEXT,           -- 'none', 'low', 'medium', 'high', 'urgent'
  due_date        DATE,
  status_from     TEXT,           -- For updates: current status
  status_to       TEXT,           -- For updates: new status

  -- People
  assignee_name   TEXT,           -- Freeform name from transcript
  assignee_member_id UUID REFERENCES member(id) ON DELETE SET NULL,  -- Resolved member
  assignee_contact_id UUID,      -- Resolved CRM contact (for external people)

  -- Entity linking
  team_id         UUID REFERENCES team(id) ON DELETE SET NULL,
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  labels          TEXT[],         -- Label names

  -- Email-specific (for send_email type)
  email_to_name   TEXT,
  email_to_address TEXT,
  email_subject   TEXT,
  email_context   TEXT,           -- Context for drafting the email

  -- Extra fields that don't fit flat columns
  extra           JSONB,          -- Overflow for edge cases

  -- Text anchoring (for positioning in the markdown summary)
  anchor_text     TEXT,           -- A snippet from the summary markdown near where this should render
  sort_order      INT NOT NULL DEFAULT 0,

  -- AI context (hidden by default, shown on expand)
  confidence      REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  trigger_quote   TEXT,           -- Direct quote from transcript
  reasoning       TEXT,           -- Why the AI is proposing this
  stakes          TEXT,           -- What happens if this doesn't get done
  open_questions  TEXT[],         -- Unresolved questions related to this

  -- Status
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'dismissed')),

  -- Apply tracking
  applied_at      TIMESTAMPTZ,
  applied_by      UUID REFERENCES member(id),
  result_entity_id UUID,         -- ID of the created/updated entity after apply
  error_message   TEXT,

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_proposed_change_capture ON proposed_change(capture_id);
CREATE INDEX idx_proposed_change_status ON proposed_change(capture_id, status);
CREATE INDEX idx_proposed_change_workspace ON proposed_change(workspace_id);

-- RLS
ALTER TABLE proposed_change ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view proposed changes"
  ON proposed_change FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM member WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Members can insert proposed changes"
  ON proposed_change FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM member WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Members can update proposed changes"
  ON proposed_change FOR UPDATE
  USING (
    workspace_id IN (
      SELECT workspace_id FROM member WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Members can delete proposed changes"
  ON proposed_change FOR DELETE
  USING (
    workspace_id IN (
      SELECT workspace_id FROM member WHERE user_id = auth.uid()
    )
  );

-- Updated_at trigger
CREATE OR REPLACE FUNCTION public.update_proposed_change_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_proposed_change_updated_at
  BEFORE UPDATE ON proposed_change
  FOR EACH ROW
  EXECUTE FUNCTION public.update_proposed_change_updated_at();

-- Realtime (for future live updates during calls)
ALTER PUBLICATION supabase_realtime ADD TABLE public.proposed_change;
