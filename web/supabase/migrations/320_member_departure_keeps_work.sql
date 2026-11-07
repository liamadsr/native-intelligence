-- 320: removing a member, or leaving, keeps what they wrote.
--
-- Before: an owner's Remove failed for anyone who had applied a suggestion
-- (proposed_change.applied_by was NO ACTION, the one reference to member that
-- refused the delete), and a departure that went through deleted the person's
-- comments and document drafts (both ON DELETE CASCADE).
--
-- After:
--   * who applied a suggestion is cleared, never blocking;
--   * a comment stays, under the name and avatar its author had when they left
--     (copied onto the comment just before the member row goes); deleting the
--     whole workspace or the person's account still deletes their comments;
--   * a document draft stays with its author's user, and is theirs again if they
--     rejoin the workspace.

-- 1. Who applied a suggestion: set null, like every other "who did this".
ALTER TABLE public.proposed_change
  DROP CONSTRAINT proposed_change_applied_by_fkey,
  ADD CONSTRAINT proposed_change_applied_by_fkey
    FOREIGN KEY (applied_by) REFERENCES public.member(id) ON DELETE SET NULL;

-- 2. Comments. A comment had exactly one author: a member (author_id) or an
-- external commenter via a share link (author_user_id). A former member's
-- comment has neither, and keeps the author's name in author_name.
ALTER TABLE public.comment
  DROP CONSTRAINT comment_author_exactly_one,
  ADD CONSTRAINT comment_author_known CHECK (
    (author_id IS NOT NULL AND author_user_id IS NULL)
    OR (author_id IS NULL AND author_user_id IS NOT NULL)
    OR (author_id IS NULL AND author_user_id IS NULL AND author_name IS NOT NULL)
  );

ALTER TABLE public.comment
  DROP CONSTRAINT comment_author_id_fkey,
  ADD CONSTRAINT comment_author_id_fkey
    FOREIGN KEY (author_id) REFERENCES public.member(id) ON DELETE SET NULL;

-- The target check ran on every update, so updating a comment whose action or
-- capture was deleted (comments are polymorphic and stay behind) raised, and
-- would refuse the departure below. It only matters when the target changes.
DROP TRIGGER comment_validate_target ON public.comment;
CREATE TRIGGER comment_validate_target
  BEFORE INSERT OR UPDATE OF commentable_type, commentable_id ON public.comment
  FOR EACH ROW EXECUTE FUNCTION public.validate_commentable_exists();

-- 3. Document drafts: keyed by the author's user as well as their member row.
-- The member link is cleared when they go (the draft has no reader then: the
-- read policy follows author_id) and restored when they rejoin.
ALTER TABLE public.document_draft
  ADD COLUMN author_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

UPDATE public.document_draft d
   SET author_user_id = m.user_id
  FROM public.member m
 WHERE m.id = d.author_id;

ALTER TABLE public.document_draft
  ALTER COLUMN author_user_id SET NOT NULL,
  DROP CONSTRAINT document_draft_pkey,
  ADD CONSTRAINT document_draft_pkey PRIMARY KEY (document_id, author_user_id),
  ALTER COLUMN author_id DROP NOT NULL,
  -- The app upserts on (document_id, author_id); NULLs stay distinct, so the
  -- drafts of several former members never collide.
  ADD CONSTRAINT document_draft_document_author_key UNIQUE (document_id, author_id),
  DROP CONSTRAINT document_draft_author_id_fkey,
  ADD CONSTRAINT document_draft_author_id_fkey
    FOREIGN KEY (author_id) REFERENCES public.member(id) ON DELETE SET NULL;

-- Every write names author_id only; the user comes from that member row. A new
-- draft replaces the same person's kept draft of that document (left behind
-- in another workspace before the document moved there): one draft per person
-- and document, and the kept one would otherwise refuse every save.
CREATE OR REPLACE FUNCTION public._document_draft_set_author_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.author_id IS NOT NULL THEN
    SELECT m.user_id INTO NEW.author_user_id FROM public.member m WHERE m.id = NEW.author_id;
  END IF;
  IF TG_OP = 'INSERT' THEN
    DELETE FROM public.document_draft d
     WHERE d.document_id = NEW.document_id
       AND d.author_user_id = NEW.author_user_id
       AND d.author_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_draft_set_author_user
  BEFORE INSERT OR UPDATE OF author_id ON public.document_draft
  FOR EACH ROW EXECUTE FUNCTION public._document_draft_set_author_user();

-- 4. Just before a member row goes: their comments keep their name. Deleting
-- the workspace or the person's account takes their comments with it, as
-- before: that cascade has already removed the workspace or user row, so it is
-- gone here. Only a departure (removed, or left) keeps them.
CREATE OR REPLACE FUNCTION public.member_departure_keeps_work()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspace w WHERE w.id = OLD.workspace_id)
     OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id) THEN
    DELETE FROM public.comment WHERE author_id = OLD.id;
  ELSE
    UPDATE public.comment
       SET author_id = NULL,
           author_name = OLD.display_name,
           author_avatar_url = OLD.avatar_url
     WHERE author_id = OLD.id;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER member_departure_keeps_work
  BEFORE DELETE ON public.member
  FOR EACH ROW EXECUTE FUNCTION public.member_departure_keeps_work();

-- 5. Rejoining: the person's drafts in this workspace are theirs again.
CREATE OR REPLACE FUNCTION public.member_rejoin_restores_drafts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.document_draft
     SET author_id = NEW.id
   WHERE workspace_id = NEW.workspace_id
     AND author_user_id = NEW.user_id
     AND author_id IS NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER member_rejoin_restores_drafts
  AFTER INSERT ON public.member
  FOR EACH ROW EXECUTE FUNCTION public.member_rejoin_restores_drafts();

REVOKE EXECUTE ON FUNCTION public._document_draft_set_author_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.member_departure_keeps_work() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.member_rejoin_restores_drafts() FROM PUBLIC, anon, authenticated;
