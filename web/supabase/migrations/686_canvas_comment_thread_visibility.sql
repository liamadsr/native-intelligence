-- ============================================================
-- 686: the comment thread check answers only for a canvas the caller can open.
-- ============================================================
-- On top of 682. canvas_comment_is_thread(parent, canvas) is what a reply may
-- name as its parent; the comment insert policy calls it after checking that
-- the caller can open the canvas. It is SECURITY DEFINER (a policy on
-- canvas_comment cannot read canvas_comment itself), and 682 granted it to
-- every signed-in person, so called directly it would say whether a comment
-- id is the first of a thread on ANY canvas. The ids are random and the
-- answer is one bit, but there is no reason to give it: the function now
-- checks the caller's access itself. A caller with no person behind it (the
-- service role) is not held to that, as before.
--
-- 682's own definition is replaced here on purpose: it is this feature's own
-- function, and 682's file must not change once it may have been applied.
-- Same name, arguments and return type, so the policy that calls it and its
-- grants stand as they are. Re-runnable. No backslashes anywhere in this file.
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

create or replace function public.canvas_comment_is_thread(p_parent uuid, p_canvas uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.canvas_comment p
     where p.id = p_parent
       and p.canvas_id = p_canvas
       and p.parent_id is null
       and ((select auth.uid()) is null or public.canvas_visible_to(p_canvas, (select auth.uid())))
  );
$$;

comment on function public.canvas_comment_is_thread(uuid, uuid) is
  'Whether a comment is the first of a thread on that canvas, for a caller who can open the canvas (682, narrowed by 686): what a reply may name as its parent.';

revoke all on function public.canvas_comment_is_thread(uuid, uuid) from public, anon;
grant execute on function public.canvas_comment_is_thread(uuid, uuid) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
