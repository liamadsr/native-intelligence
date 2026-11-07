-- Allow a user to link multiple local repo paths to a single project.
-- Previously UNIQUE(project_id, user_id) enforced one path per user per project.
ALTER TABLE project_local_path DROP CONSTRAINT project_local_path_project_id_user_id_key;
