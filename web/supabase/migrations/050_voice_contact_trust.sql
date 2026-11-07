-- ============================================================
-- 050: Voice Contact Trust — progressive trust for Voice ID
-- Tracks per-contact confirmation count and total enrollment count.
-- Trust tiers control whether matching is silent, suggested, or prompted.
-- ============================================================

-- ============================================================
-- 1. Trust summary table (one row per workspace+contact)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.voice_contact_trust (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contact (id) ON DELETE CASCADE,
  confirmation_count integer NOT NULL DEFAULT 0,
  total_enrollment_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (workspace_id, contact_id)
);

CREATE INDEX IF NOT EXISTS voice_contact_trust_workspace_idx
  ON public.voice_contact_trust (workspace_id);

CREATE INDEX IF NOT EXISTS voice_contact_trust_contact_idx
  ON public.voice_contact_trust (contact_id);

-- ============================================================
-- 2. RLS policies — workspace member access
-- ============================================================

ALTER TABLE public.voice_contact_trust ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view voice contact trust"
  ON public.voice_contact_trust FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace members can manage voice contact trust"
  ON public.voice_contact_trust FOR ALL
  USING (public.is_workspace_member(workspace_id));
