-- 128: Project-level attachments + workspace-shared visibility.
--
-- (a) Attachments could only parent to a capture (note_id) or an action —
--     the has-parent CHECK (083) rejected project-only rows even though the
--     project_id column exists. Widen the CHECK so files can attach straight
--     to a project (this is the entry point for reference ingestion).
--
-- (b) RLS on attachments and on the storage bucket was owner-only
--     (auth.uid() = user_id / {user_id}/... path prefix), so the project
--     Files tab — a workspace surface that rolls up teammates' capture
--     files — silently showed only the caller's own rows, and signed URLs
--     for teammates' files failed. Add ADDITIVE workspace-member policies
--     for SELECT and DELETE. INSERT/UPDATE stay owner-scoped: uploads always
--     write to the uploader's own storage folder.
--
-- Idempotent: drop-by-name + re-create.

-- (a) project_id becomes a valid sole parent ------------------------------

ALTER TABLE public.attachments DROP CONSTRAINT IF EXISTS attachments_has_parent;
ALTER TABLE public.attachments ADD CONSTRAINT attachments_has_parent
  CHECK (note_id IS NOT NULL OR action_id IS NOT NULL OR project_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_attachments_project
  ON public.attachments (project_id) WHERE project_id IS NOT NULL;

-- (b) workspace-shared visibility -----------------------------------------

DROP POLICY IF EXISTS attachments_workspace_select ON public.attachments;
CREATE POLICY attachments_workspace_select ON public.attachments
  FOR SELECT USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS attachments_workspace_delete ON public.attachments;
CREATE POLICY attachments_workspace_delete ON public.attachments
  FOR DELETE USING (public.is_workspace_member(workspace_id));

-- Storage objects: members may read/delete objects that back an attachments
-- row in their workspace. Authorization rides on the row, so app code must
-- remove storage objects BEFORE deleting the row.
DROP POLICY IF EXISTS "attachments workspace read" ON storage.objects;
CREATE POLICY "attachments workspace read" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'attachments' AND EXISTS (
      SELECT 1 FROM public.attachments a
      WHERE (a.storage_path = storage.objects.name OR a.thumbnail_path = storage.objects.name)
        AND public.is_workspace_member(a.workspace_id)
    )
  );

DROP POLICY IF EXISTS "attachments workspace delete" ON storage.objects;
CREATE POLICY "attachments workspace delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'attachments' AND EXISTS (
      SELECT 1 FROM public.attachments a
      WHERE (a.storage_path = storage.objects.name OR a.thumbnail_path = storage.objects.name)
        AND public.is_workspace_member(a.workspace_id)
    )
  );
