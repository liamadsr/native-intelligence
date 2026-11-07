-- Migration 038: Email Thread Labels
-- Allows workspace labels to be attached to email threads (same labels used for actions/tasks)

-- ============================================================
-- 1. email_thread_label join table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.email_thread_label (
  thread_id UUID NOT NULL REFERENCES public.email_thread_index (id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES public.label (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_email_thread_label_label ON public.email_thread_label (label_id);
CREATE INDEX IF NOT EXISTS idx_email_thread_label_thread ON public.email_thread_label (thread_id);

-- ============================================================
-- 2. RLS policies
-- ============================================================

ALTER TABLE public.email_thread_label ENABLE ROW LEVEL SECURITY;

-- Anyone who can see the thread can see its labels
CREATE POLICY "Email thread label access follows thread access"
  ON public.email_thread_label FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.email_thread_index t
      WHERE t.id = email_thread_label.thread_id
        AND t.user_id = auth.uid()
    )
  );

-- Thread owner can manage labels on their threads
CREATE POLICY "Thread owners can manage email thread labels"
  ON public.email_thread_label FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.email_thread_index t
      WHERE t.id = email_thread_label.thread_id
        AND t.user_id = auth.uid()
    )
  );
