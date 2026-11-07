-- 402: merge workspaces — fold one workspace into another, whole, in one
-- transaction. Design: docs/plans/merge-workspaces.md (2026-10-20).
--
-- What lands:
--   workspace_merge               the record of a merge: source snapshot, plan,
--                                 counts, maps. NO foreign keys to either
--                                 workspace (the source is gone when it commits).
--   workspace_move_log            loses its two ON DELETE CASCADE foreign keys
--                                 so move history survives a merged-away
--                                 workspace (moved_by already had none).
--   _wsmerge_active()             true inside a merge transaction (a
--                                 transaction-local setting the merge sets).
--   three guard exemptions        reminder_freeze_identity (224),
--                                 ai_team_member_protect_system (283) and
--                                 flow_check_ai_team_member (302) step aside
--                                 inside a merge. The document guards already
--                                 let server paths through (current_user), and
--                                 the member / area_memory / teammate guards
--                                 already exempt the service role.
--   workspace_integrity_sweep()   the tenancy invariants as one query, used by
--                                 the preflight on both sides (pre-existing
--                                 drift is shown, never blamed on the merge)
--                                 and by the merge as its last assertion.
--   export_workspace_manifest()   paged JSON export of a workspace, for the
--   export_workspace_rows()       snapshot the route stores before merging.
--   merge_workspace_preflight()   the same rules, read-only: the plan.
--   merge_workspace()             the merge.
--
-- The rules the merge applies are the ones the plan document states; the
-- header of each helper below repeats the rule it implements. What matters
-- most, in one place:
--   * Everything moves. Rows re-stamp with their ids unchanged; duplicates of
--     what the destination already has (a member, a label, a contact by
--     email, a company by domain, a system teammate, the seeded Triage loop,
--     a home thread, a canon document, a mail thread copy, a dedupe record)
--     FOLD into the destination's row with their children re-pointed first.
--     Nothing is severed or left behind, unlike the move engine (221), whose
--     per-entity sever rules exist for a source tenant that lives on.
--   * Teams arrive as their own team by default (renamed when the slug or
--     prefix collides; identifiers re-prefixed with the number kept) or fold
--     into a destination team on request (engine ladder for states,
--     identifiers preserved when free, renumbered from the watermark only on
--     collision). previous_identifier keeps every old handle.
--   * Integrations: a provider only the source has comes over whole; one
--     both sides have keeps the destination's, and the source's links are
--     severed with the URL kept on the action (the engine's rule and reason).
--   * The merge refuses to start while the source is busy (live capture,
--     running agent run, flow run or tracked job) or while either side fails
--     the integrity sweep, and it ends by asserting that no table still holds
--     a source row and that the destination passes the sweep. Any failure
--     rolls the whole transaction back: the database is as it was.
--   * Callable by the service role only (the route authenticates: owner of
--     both workspaces), with the actor passed in. The authenticated role's
--     8 s statement_timeout cannot hold a whole-workspace merge.
--
-- DEV and PROD differ today (deal / deal_contact, workflow_state.entity_kind
-- and voice_contact_trust.model exist on DEV only): the file references only
-- columns both have, and reaches the deal tables through to_regclass guards.
--
-- Error codes: P0002 not found / no membership (anti-oracle, as 221),
-- 42501 role, 22023 same workspace, P0006 plan invalid or stale, P0007
-- source busy, P0008 assertion failed, P0009 pre-existing drift.

-- ============================================================
-- 0. Schema
-- ============================================================

CREATE TABLE IF NOT EXISTS public.workspace_merge (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_workspace_id       uuid NOT NULL,
  source_name               text NOT NULL,
  source_slug               text NOT NULL,
  source_settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_created_at         timestamptz,
  destination_workspace_id  uuid NOT NULL,
  actor_user_id             uuid NOT NULL,
  plan                      jsonb NOT NULL DEFAULT '{}'::jsonb,
  counts                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot                  jsonb,
  started_at                timestamptz NOT NULL,
  finished_at               timestamptz NOT NULL DEFAULT now(),
  duration_ms               integer
);

CREATE INDEX IF NOT EXISTS workspace_merge_destination_idx
  ON public.workspace_merge (destination_workspace_id, finished_at DESC);
CREATE INDEX IF NOT EXISTS workspace_merge_source_idx
  ON public.workspace_merge (source_workspace_id);

ALTER TABLE public.workspace_merge ENABLE ROW LEVEL SECURITY;

-- Members of the destination may read what was merged into it. Writes happen
-- only inside merge_workspace (no INSERT/UPDATE/DELETE policies).
DROP POLICY IF EXISTS workspace_merge_select ON public.workspace_merge;
CREATE POLICY workspace_merge_select ON public.workspace_merge
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(destination_workspace_id));

-- Move history survives a merged-away workspace. The ids stay as plain uuids.
ALTER TABLE public.workspace_move_log
  DROP CONSTRAINT IF EXISTS workspace_move_log_source_workspace_id_fkey;
ALTER TABLE public.workspace_move_log
  DROP CONSTRAINT IF EXISTS workspace_move_log_destination_workspace_id_fkey;

-- ============================================================
-- 1. The merge setting and the three guard exemptions
-- ============================================================

-- True inside a merge: merge_workspace sets 'dial8.workspace_merge' for its
-- transaction (set_config(..., true)), so nothing outside it ever sees it.
CREATE OR REPLACE FUNCTION public._wsmerge_active()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(current_setting('dial8.workspace_merge', true), '') <> '';
$$;

-- 224: a reminder never changes workspace — except when its whole workspace
-- does.
CREATE OR REPLACE FUNCTION public.reminder_freeze_identity()
RETURNS trigger AS $$
BEGIN
  IF public._wsmerge_active() THEN
    RETURN new;
  END IF;
  IF new.workspace_id IS DISTINCT FROM old.workspace_id
     OR new.user_id     IS DISTINCT FROM old.user_id
     OR new.entity_type IS DISTINCT FROM old.entity_type
     OR new.entity_id   IS DISTINCT FROM old.entity_id THEN
    RAISE EXCEPTION 'reminder identity (workspace_id, user_id, entity_type, entity_id) is immutable'
      USING ERRCODE = '42501';
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql;

-- 283: a system teammate is never deleted while its workspace and team exist
-- — except by a merge, which folds it onto the destination's twin first.
CREATE OR REPLACE FUNCTION public.ai_team_member_protect_system()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'DELETE' then
    if old.is_system
       and not public._wsmerge_active()
       and exists (select 1 from public.workspace w where w.id = old.workspace_id)
       and exists (select 1 from public.team t where t.id = old.team_id) then
      raise exception 'system teammates cannot be deleted (ai_team_member %)', old.id
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if new.is_system is distinct from old.is_system
     or new.system_key is distinct from old.system_key
     or (old.is_system and new.agent_recipe_id is distinct from old.agent_recipe_id) then
    raise exception 'is_system, system_key and a system teammate''s agent are fixed at insert (ai_team_member %)', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$function$;

-- 302: a loop that changes workspace leaves its bot behind — except in a
-- merge, which moves the bot along (or maps it onto the destination's system
-- twin) in the same statement and keeps every consistency rule itself.
CREATE OR REPLACE FUNCTION public.flow_check_ai_team_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_mate record;
  v_editor uuid := auth.uid();
  v_run_as uuid;
  v_seed_key text;
begin
  if new.ai_team_member_id is null then
    return new;
  end if;
  if public._wsmerge_active() then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- A loop moved to another workspace leaves its bot behind (never a
    -- pointer across workspaces): its editor there asks for one.
    if new.workspace_id is distinct from old.workspace_id
       and new.ai_team_member_id is not distinct from old.ai_team_member_id then
      new.ai_team_member_id := null;
      return new;
    end if;
    -- Nothing the checks read changed: the bot, the workspace, the seed key.
    if new.ai_team_member_id is not distinct from old.ai_team_member_id
       and new.seed_key is not distinct from old.seed_key then
      return new;
    end if;
  end if;

  select atm.workspace_id, atm.team_id, atm.is_system, atm.system_key, t.is_private
    into v_mate
  from public.ai_team_member atm
  left join public.team t on t.id = atm.team_id
  where atm.id = new.ai_team_member_id;
  if not found then
    -- The FK reports a missing row too; this only keeps the message readable.
    raise exception 'that bot no longer exists' using errcode = 'check_violation';
  end if;

  if v_mate.workspace_id is distinct from new.workspace_id then
    raise exception 'a loop''s bot must be one of its own workspace''s teammates'
      using errcode = 'check_violation';
  end if;

  if v_mate.is_system then
    if v_mate.system_key is null or v_mate.system_key not in ('captures') then
      raise exception 'this built-in teammate does not front loops'
        using errcode = 'check_violation';
    end if;
    v_seed_key := case new.seed_key
      when 'seed:triage' then 'captures'
      when 'seed:reconcile' then 'captures'
    end;
    if v_seed_key is not null and v_seed_key <> v_mate.system_key then
      raise exception 'a built-in loop keeps its own teammate'
        using errcode = 'check_violation';
    end if;
    -- A system teammate is readable across private teams (280): everyone reaches it.
    return new;
  end if;

  -- Only an explicit false is public (callerCanReachTeammate's rule).
  if v_mate.is_private is false then
    return new;
  end if;

  if v_editor is not null and not exists (
    select 1
    from public.team_member tm
    join public.member m on m.id = tm.member_id
    where tm.team_id = v_mate.team_id
      and m.user_id = v_editor
      and m.workspace_id = new.workspace_id
  ) then
    raise exception 'that bot is on a private team you are not on'
      using errcode = 'check_violation';
  end if;

  -- The run-as member (run-as-member.ts): the creator while still a member,
  -- else the workspace owner.
  select m.id into v_run_as
  from public.member m
  where m.workspace_id = new.workspace_id
    and m.user_id = new.created_by
  limit 1;
  if v_run_as is null then
    select m.id into v_run_as
    from public.member m
    where m.workspace_id = new.workspace_id
      and m.role = 'owner'
    order by m.created_at asc
    limit 1;
  end if;
  if v_run_as is null or not exists (
    select 1 from public.team_member tm
    where tm.team_id = v_mate.team_id
      and tm.member_id = v_run_as
  ) then
    raise exception 'the person this loop runs as can''t see that bot (it is on a private team they are not on)'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;

-- ============================================================
-- 2. The integrity sweep
--    Every tenancy invariant the move engine's 44-check sweep proved, as one
--    query over one workspace: a child whose workspace differs from its
--    parent's, a junction whose two ends sit in different workspaces, a
--    member reference from another workspace. Returns only the checks that
--    fail (violations > 0).
-- ============================================================

CREATE OR REPLACE FUNCTION public.workspace_integrity_sweep(p_workspace uuid)
RETURNS TABLE (check_name text, violations bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH checks AS (
    SELECT 'actions.team_workspace' AS c, count(*) AS n FROM public.actions a JOIN public.team t ON t.id = a.team_id
      WHERE a.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.status_team', count(*) FROM public.actions a JOIN public.workflow_state s ON s.id = a.status_id
      WHERE a.workspace_id = p_workspace AND s.team_id <> a.team_id
    UNION ALL SELECT 'actions.assignee_member', count(*) FROM public.actions a JOIN public.member m ON m.id = a.assignee_id
      WHERE a.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.assignee_ai_member', count(*) FROM public.actions a JOIN public.ai_team_member m ON m.id = a.assignee_ai_member_id
      WHERE a.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.assignee_contact', count(*) FROM public.actions a JOIN public.contact c ON c.id = a.assignee_contact_id
      WHERE a.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.project', count(*) FROM public.actions a JOIN public.projects p ON p.id = a.project_id
      WHERE a.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.milestone_project', count(*) FROM public.actions a JOIN public.milestone ms ON ms.id = a.milestone_id JOIN public.projects p ON p.id = ms.project_id
      WHERE a.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.cycle_team', count(*) FROM public.actions a JOIN public.cycle cy ON cy.id = a.cycle_id
      WHERE a.workspace_id = p_workspace AND cy.team_id <> a.team_id
    UNION ALL SELECT 'actions.parent', count(*) FROM public.actions a JOIN public.actions p ON p.id = a.parent_id
      WHERE a.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.source_capture', count(*) FROM public.actions a JOIN public.captures c ON c.id = a.source_capture_id
      WHERE a.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'action_assignee.member', count(*) FROM public.action_assignee x JOIN public.actions a ON a.id = x.action_id JOIN public.member m ON m.id = x.member_id
      WHERE a.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'action_label.label', count(*) FROM public.action_label x JOIN public.actions a ON a.id = x.action_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_label.label', count(*) FROM public.capture_label x JOIN public.captures a ON a.id = x.capture_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'project_label.label', count(*) FROM public.project_label x JOIN public.projects a ON a.id = x.project_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'initiative_label.label', count(*) FROM public.initiative_label x JOIN public.initiative a ON a.id = x.initiative_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'email_thread_label.label', count(*) FROM public.email_thread_label x JOIN public.email_thread_index a ON a.id = x.thread_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'action_relation.ends', count(*) FROM public.action_relation r JOIN public.actions a ON a.id = r.action_id JOIN public.actions b ON b.id = r.related_action_id
      WHERE a.workspace_id = p_workspace AND b.workspace_id <> p_workspace
    UNION ALL SELECT 'action_document.ends', count(*) FROM public.action_document r JOIN public.actions a ON a.id = r.action_id JOIN public.document d ON d.id = r.document_id
      WHERE a.workspace_id = p_workspace AND d.workspace_id <> p_workspace
    UNION ALL SELECT 'action_external_task.action', count(*) FROM public.action_external_task x JOIN public.actions a ON a.id = x.action_id
      WHERE x.workspace_id = p_workspace AND a.workspace_id <> p_workspace
    UNION ALL SELECT 'action_github_pr.action', count(*) FROM public.action_github_pr x JOIN public.actions a ON a.id = x.action_id
      WHERE x.workspace_id = p_workspace AND a.workspace_id <> p_workspace
    UNION ALL SELECT 'agent_run.action', count(*) FROM public.agent_run x JOIN public.actions a ON a.id = x.action_id
      WHERE x.workspace_id = p_workspace AND a.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_chunks.capture', count(*) FROM public.capture_chunks x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_references.capture', count(*) FROM public.capture_references x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'extraction_pass.capture', count(*) FROM public.extraction_pass x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_participant.member', count(*) FROM public.capture_participant x JOIN public.captures c ON c.id = x.capture_id JOIN public.member m ON m.id = x.member_id
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_participant.contact', count(*) FROM public.capture_participant x JOIN public.captures c ON c.id = x.capture_id JOIN public.contact ct ON ct.id = x.contact_id
      WHERE c.workspace_id = p_workspace AND ct.workspace_id <> p_workspace
    UNION ALL SELECT 'captures.team', count(*) FROM public.captures c JOIN public.team t ON t.id = c.team_id
      WHERE c.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'captures.project', count(*) FROM public.captures c JOIN public.projects p ON p.id = c.project_id
      WHERE c.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'document_chunks.document', count(*) FROM public.document_chunks x JOIN public.document d ON d.id = x.document_id
      WHERE x.workspace_id = p_workspace AND d.workspace_id <> p_workspace
    UNION ALL SELECT 'document_revision.document', count(*) FROM public.document_revision x JOIN public.document d ON d.id = x.document_id
      WHERE x.workspace_id = p_workspace AND d.workspace_id <> p_workspace
    UNION ALL SELECT 'document_draft.document', count(*) FROM public.document_draft x JOIN public.document d ON d.id = x.document_id
      WHERE x.workspace_id = p_workspace AND d.workspace_id <> p_workspace
    UNION ALL SELECT 'document.team', count(*) FROM public.document d JOIN public.team t ON t.id = d.team_id
      WHERE d.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'document.project', count(*) FROM public.document d JOIN public.projects p ON p.id = d.project_id
      WHERE d.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'document.created_by', count(*) FROM public.document d JOIN public.member m ON m.id = d.created_by
      WHERE d.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'claim_chunks.claim', count(*) FROM public.claim_chunks x JOIN public.claim c ON c.id = x.claim_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'claim_source.claim', count(*) FROM public.claim_source x JOIN public.claim c ON c.id = x.claim_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'claim.created_by', count(*) FROM public.claim c JOIN public.member m ON m.id = c.created_by
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'attachments.parent', count(*) FROM public.attachments x
      LEFT JOIN public.captures c ON c.id = x.note_id LEFT JOIN public.actions a ON a.id = x.action_id LEFT JOIN public.projects p ON p.id = x.project_id
      WHERE x.workspace_id = p_workspace AND COALESCE(c.workspace_id, a.workspace_id, p.workspace_id) <> p_workspace
    UNION ALL SELECT 'attachment_chunks.attachment', count(*) FROM public.attachment_chunks x JOIN public.attachments a ON a.id = x.attachment_id
      WHERE x.workspace_id = p_workspace AND a.workspace_id <> p_workspace
    UNION ALL SELECT 'anchor_embedding.project', count(*) FROM public.anchor_embedding x JOIN public.projects p ON p.id = x.entity_id AND x.entity_type = 'project'
      WHERE x.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'projects.initiative', count(*) FROM public.projects p JOIN public.initiative i ON i.id = p.initiative_id
      WHERE p.workspace_id = p_workspace AND i.workspace_id <> p_workspace
    UNION ALL SELECT 'projects.parent', count(*) FROM public.projects p JOIN public.projects q ON q.id = p.parent_project_id
      WHERE p.workspace_id = p_workspace AND q.workspace_id <> p_workspace
    UNION ALL SELECT 'projects.lead', count(*) FROM public.projects p JOIN public.member m ON m.id = p.lead_id
      WHERE p.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'proposed_change.capture', count(*) FROM public.proposed_change x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'proposed_change.team', count(*) FROM public.proposed_change x JOIN public.team t ON t.id = x.team_id
      WHERE x.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'proposed_change.assignee', count(*) FROM public.proposed_change x JOIN public.member m ON m.id = x.assignee_member_id
      WHERE x.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'decision.project', count(*) FROM public.decision d JOIN public.captures c ON c.id = d.capture_id JOIN public.projects p ON p.id = d.project_id
      WHERE c.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'decision.decided_by', count(*) FROM public.decision d JOIN public.captures c ON c.id = d.capture_id JOIN public.member m ON m.id = d.decided_by
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'chat_conversations.capture', count(*) FROM public.chat_conversations x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'chat_conversations.teammate', count(*) FROM public.chat_conversations x JOIN public.ai_team_member m ON m.id = x.ai_team_member_id
      WHERE x.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'share.shareable', count(*) FROM public.share s
      LEFT JOIN public.captures c ON c.id = s.shareable_id AND s.shareable_type = 'capture'
      LEFT JOIN public.document d ON d.id = s.shareable_id AND s.shareable_type = 'document'
      WHERE s.workspace_id = p_workspace AND s.is_active AND COALESCE(c.workspace_id, d.workspace_id) <> p_workspace
    UNION ALL SELECT 'share.created_by', count(*) FROM public.share s JOIN public.member m ON m.id = s.created_by
      WHERE s.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'email_thread_index.links', count(*) FROM public.email_thread_index e
      LEFT JOIN public.actions a ON a.id = e.linked_action_id LEFT JOIN public.captures c ON c.id = e.linked_capture_id
      LEFT JOIN public.projects p ON p.id = e.linked_project_id LEFT JOIN public.contact ct ON ct.id = e.linked_contact_id
      WHERE e.workspace_id = p_workspace AND (a.workspace_id <> p_workspace OR c.workspace_id <> p_workspace OR p.workspace_id <> p_workspace OR ct.workspace_id <> p_workspace)
    UNION ALL SELECT 'entity_link.ends', count(*) FROM public.entity_link l
      WHERE l.workspace_id = p_workspace AND (
        EXISTS (SELECT 1 FROM public.actions a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.document a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.contact a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.company a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.claim a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace))
    UNION ALL SELECT 'knowledge_package_item.entity', count(*) FROM public.knowledge_package_item i
      WHERE i.workspace_id = p_workspace AND (
        EXISTS (SELECT 1 FROM public.actions a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.document a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.claim a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace))
    UNION ALL SELECT 'knowledge_package.team', count(*) FROM public.knowledge_package k JOIN public.team t ON t.id = k.team_id
      WHERE k.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'comment.author', count(*) FROM public.comment x JOIN public.member m ON m.id = x.author_id
      WHERE m.workspace_id <> p_workspace AND (
        EXISTS (SELECT 1 FROM public.actions a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace)
        OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace)
        OR EXISTS (SELECT 1 FROM public.document a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace)
        OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace)
        OR EXISTS (SELECT 1 FROM public.contact a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace))
    UNION ALL SELECT 'team_member.member', count(*) FROM public.team_member x JOIN public.team t ON t.id = x.team_id JOIN public.member m ON m.id = x.member_id
      WHERE t.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'ai_team_member.team', count(*) FROM public.ai_team_member x JOIN public.team t ON t.id = x.team_id
      WHERE x.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'flow.team', count(*) FROM public.flow x JOIN public.team t ON t.id = x.team_id
      WHERE x.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'flow.teammate', count(*) FROM public.flow x JOIN public.ai_team_member m ON m.id = x.ai_team_member_id
      WHERE x.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'view.team', count(*) FROM public.view x JOIN public.team t ON t.id = x.team_id
      WHERE x.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'contact.company', count(*) FROM public.contact c JOIN public.company co ON co.id = c.company_id
      WHERE c.workspace_id = p_workspace AND co.workspace_id <> p_workspace
    UNION ALL SELECT 'contact.member', count(*) FROM public.contact c JOIN public.member m ON m.id = c.member_id
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'contact.created_by', count(*) FROM public.contact c JOIN public.member m ON m.id = c.created_by_member_id
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'contact_share.target', count(*) FROM public.contact_share s
      LEFT JOIN public.member m ON m.id = s.shared_with_member_id LEFT JOIN public.team t ON t.id = s.shared_with_team_id
      WHERE s.workspace_id = p_workspace AND (m.workspace_id <> p_workspace OR t.workspace_id <> p_workspace)
    UNION ALL SELECT 'contact_share.contact', count(*) FROM public.contact_share s JOIN public.contact c ON c.id = s.contact_id
      WHERE s.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'initiative.owner', count(*) FROM public.initiative i JOIN public.member m ON m.id = i.owner_id
      WHERE i.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'notification.recipient', count(*) FROM public.notification n JOIN public.member m ON m.id = n.recipient_id
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'attention_item.member', count(*) FROM public.attention_item n JOIN public.member m ON m.id = n.member_id
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'tracked_job.member', count(*) FROM public.tracked_job n JOIN public.member m ON m.id = n.member_id
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'tool_approval.member', count(*) FROM public.tool_approval n JOIN public.member m ON m.id = n.member_id
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'invite.invited_by', count(*) FROM public.invite n JOIN public.member m ON m.id = n.invited_by
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'connected_account_workspace.home', count(*) FROM public.connected_account_workspace j JOIN public.connected_account a ON a.id = j.account_id
      WHERE j.workspace_id = p_workspace AND a.workspace_id = p_workspace AND j.workspace_id <> a.workspace_id
  )
  SELECT c, n FROM checks WHERE n > 0;

  -- Deals exist on DEV only today: their two checks run where the table does.
  IF to_regclass('public.deal') IS NOT NULL THEN
    RETURN QUERY EXECUTE $q$
      WITH checks AS (
        SELECT 'deal.team' AS c, count(*) AS n FROM public.deal d JOIN public.team t ON t.id = d.team_id
          WHERE d.workspace_id = $1 AND t.workspace_id <> $1
        UNION ALL SELECT 'deal.status_team', count(*) FROM public.deal d JOIN public.workflow_state s ON s.id = d.status_id
          WHERE d.workspace_id = $1 AND s.team_id <> d.team_id
      )
      SELECT c, n FROM checks WHERE n > 0
    $q$ USING p_workspace;
  END IF;
END;
$$;

-- ============================================================
-- 3. Small helpers
-- ============================================================

CREATE OR REPLACE FUNCTION public._wsmerge_role_rank(p_role text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'member' THEN 2 WHEN 'guest' THEN 1 ELSE 0 END;
$$;

CREATE OR REPLACE FUNCTION public._wsmerge_slugify(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(NULLIF(trim(both '-' from regexp_replace(lower(COALESCE(p_text, '')), '[^a-z0-9]+', '-', 'g')), ''), 'team');
$$;

-- A team slug free in the workspace: base, base-2, base-3, …
CREATE OR REPLACE FUNCTION public._wsmerge_free_slug(p_workspace uuid, p_base text, p_taken text[] DEFAULT '{}')
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v text := public._wsmerge_slugify(p_base); i int := 1;
BEGIN
  WHILE EXISTS (SELECT 1 FROM public.team t WHERE t.workspace_id = p_workspace AND t.slug = v)
        OR v = ANY(p_taken) LOOP
    i := i + 1;
    v := public._wsmerge_slugify(p_base) || '-' || i;
  END LOOP;
  RETURN v;
END;
$$;

-- The app derives a prefix as the first three letters, upper-cased; the same
-- here, then made free: COH, COH2, COH3, …
CREATE OR REPLACE FUNCTION public._wsmerge_derive_prefix(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(NULLIF(upper(left(regexp_replace(COALESCE(p_name, ''), '[^A-Za-z0-9]', '', 'g'), 3)), ''), 'TM');
$$;

CREATE OR REPLACE FUNCTION public._wsmerge_free_prefix(p_workspace uuid, p_base text, p_taken text[] DEFAULT '{}')
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v text := p_base; i int := 1;
BEGIN
  WHILE EXISTS (SELECT 1 FROM public.team t WHERE t.workspace_id = p_workspace AND t.issue_prefix = v)
        OR v = ANY(p_taken) LOOP
    i := i + 1;
    v := p_base || i;
  END LOOP;
  RETURN v;
END;
$$;

-- What is running in a workspace. A merge refuses to start while any of it is.
CREATE OR REPLACE FUNCTION public._wsmerge_busy(p_workspace uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'live_captures', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title) ORDER BY c.started_at)
       FROM public.captures c WHERE c.workspace_id = p_workspace AND c.status = 'active' AND c.started_at IS NOT NULL AND c.ended_at IS NULL), '[]'::jsonb),
    'agent_runs', (SELECT count(*) FROM public.agent_run r WHERE r.workspace_id = p_workspace AND r.status IN ('queued', 'running', 'needs_input', 'canceling', 'pr_open')),
    'flow_runs', (SELECT count(*) FROM public.flow_run fr JOIN public.flow f ON f.id = fr.flow_id WHERE f.workspace_id = p_workspace AND fr.status = 'pending'),
    'tracked_jobs', (SELECT count(*) FROM public.tracked_job j WHERE j.workspace_id = p_workspace AND j.status IN ('queued', 'running', 'needs_input', 'needs_review', 'waiting_on_child'))
  );
$$;

-- Rewrite ids inside free-form JSON (saved view filters, flow configs,
-- package rules) through the merge's id map (pg_temp._wsmerge_ids). Uuids are
-- unique strings, so a text replace is exact; a NULL or empty map is a no-op.
CREATE OR REPLACE FUNCTION public._wsmerge_rewrite_json(p_json jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE v text; r record;
BEGIN
  IF p_json IS NULL THEN RETURN NULL; END IF;
  v := p_json::text;
  FOR r IN SELECT src, dst FROM pg_temp._wsmerge_ids LOOP
    v := replace(v, r.src::text, r.dst::text);
  END LOOP;
  RETURN v::jsonb;
END;
$$;

-- ============================================================
-- 4. The plan: what the person decides (teams), proposed and validated
-- ============================================================

-- The default plan: every source team arrives as its own team. A team whose
-- slug or prefix collides is renamed: the source's first team (its General)
-- takes the source workspace's name, any other keeps its name with the
-- source's in brackets; the slug follows the name, the prefix is derived from
-- it (first three letters, as the app does) and made free.
CREATE OR REPLACE FUNCTION public._wsmerge_propose_teams(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_src_name text;
  v_oldest uuid;
  v_out jsonb := '[]'::jsonb;
  v_name text; v_slug text; v_prefix text;
  v_slug_free boolean; v_prefix_free boolean;
  v_taken_slugs text[] := '{}'; v_taken_prefixes text[] := '{}';
BEGIN
  SELECT name INTO v_src_name FROM public.workspace WHERE id = p_source;
  -- The source's first team: the oldest, and among teams created in the same
  -- transaction (one created_at) the one the workspace trigger made, slug
  -- 'general', so the choice never depends on uuid order.
  SELECT id INTO v_oldest FROM public.team WHERE workspace_id = p_source ORDER BY created_at, (slug <> 'general'), id LIMIT 1;

  FOR r IN SELECT * FROM public.team WHERE workspace_id = p_source ORDER BY created_at, (slug <> 'general'), id LOOP
    v_slug_free := NOT EXISTS (SELECT 1 FROM public.team t WHERE t.workspace_id = p_dest AND t.slug = r.slug)
                   AND NOT (r.slug = ANY(v_taken_slugs));
    v_prefix_free := NOT EXISTS (SELECT 1 FROM public.team t WHERE t.workspace_id = p_dest AND t.issue_prefix = r.issue_prefix)
                     AND NOT (r.issue_prefix = ANY(v_taken_prefixes));

    IF v_slug_free THEN
      v_name := r.name;
      v_slug := r.slug;
    ELSE
      v_name := CASE WHEN r.id = v_oldest THEN v_src_name ELSE r.name || ' (' || v_src_name || ')' END;
      v_slug := public._wsmerge_free_slug(p_dest, v_name, v_taken_slugs);
    END IF;
    v_prefix := CASE WHEN v_prefix_free THEN r.issue_prefix
                     ELSE public._wsmerge_free_prefix(p_dest, public._wsmerge_derive_prefix(v_name), v_taken_prefixes) END;
    v_taken_slugs := v_taken_slugs || v_slug;
    v_taken_prefixes := v_taken_prefixes || v_prefix;

    v_out := v_out || jsonb_build_object(
      'source_team_id', r.id,
      'source_name', r.name,
      'source_slug', r.slug,
      'source_prefix', r.issue_prefix,
      'is_private', r.is_private,
      'is_first', r.id = v_oldest,
      'actions', (SELECT count(*) FROM public.actions a WHERE a.team_id = r.id AND a.workspace_id = p_source),
      'members', (SELECT count(*) FROM public.team_member tm WHERE tm.team_id = r.id),
      'collides', jsonb_build_object('slug', NOT v_slug_free, 'prefix', NOT v_prefix_free),
      'mode', 'own',
      'destination_team_id', NULL,
      'name', v_name,
      'slug', v_slug,
      'prefix', v_prefix
    );
  END LOOP;
  RETURN v_out;
END;
$$;

-- Validate and normalise a plan: every source team gets a row (a missing one
-- takes the proposal), 'fold' needs a destination team with a default state,
-- 'own' needs a slug and prefix that are free in the destination and among
-- the other arriving teams. Anything else is P0006 (the UI re-runs the
-- preflight).
CREATE OR REPLACE FUNCTION public._wsmerge_plan(p_source uuid, p_dest uuid, p_plan jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_proposed jsonb := public._wsmerge_propose_teams(p_source, p_dest);
  v_given jsonb := COALESCE(p_plan->'teams', '[]'::jsonb);
  v_out jsonb := '[]'::jsonb;
  t jsonb; g jsonb;
  v_mode text; v_dst uuid; v_name text; v_slug text; v_prefix text;
  v_slugs text[] := '{}'; v_prefixes text[] := '{}';
BEGIN
  IF jsonb_typeof(v_given) <> 'array' THEN
    RAISE EXCEPTION 'plan.teams must be an array' USING ERRCODE = 'P0006';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_given) e
    WHERE NOT EXISTS (SELECT 1 FROM public.team tm WHERE tm.id = (e.value->>'source_team_id')::uuid AND tm.workspace_id = p_source)
  ) THEN
    RAISE EXCEPTION 'plan names a team that is not in the source workspace' USING ERRCODE = 'P0006';
  END IF;

  FOR t IN SELECT value FROM jsonb_array_elements(v_proposed) LOOP
    SELECT e.value INTO g FROM jsonb_array_elements(v_given) e
    WHERE e.value->>'source_team_id' = t->>'source_team_id' LIMIT 1;
    v_mode := COALESCE(g->>'mode', 'own');

    IF v_mode = 'fold' THEN
      v_dst := NULLIF(g->>'destination_team_id', '')::uuid;
      IF v_dst IS NULL OR NOT EXISTS (SELECT 1 FROM public.team tm WHERE tm.id = v_dst AND tm.workspace_id = p_dest) THEN
        RAISE EXCEPTION 'folding a team needs a destination team in the destination workspace' USING ERRCODE = 'P0006';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.workflow_state ws WHERE ws.team_id = v_dst AND ws.is_default) THEN
        RAISE EXCEPTION 'destination team has no default workflow state' USING ERRCODE = 'P0003';
      END IF;
      t := t || jsonb_build_object('mode', 'fold', 'destination_team_id', v_dst, 'name', NULL, 'slug', NULL, 'prefix', NULL);
    ELSIF v_mode = 'own' THEN
      v_name := COALESCE(NULLIF(trim(g->>'name'), ''), t->>'name');
      v_slug := COALESCE(
        NULLIF(trim(g->>'slug'), ''),
        CASE WHEN v_name <> (t->>'name') THEN public._wsmerge_slugify(v_name) ELSE t->>'slug' END);
      v_prefix := upper(trim(COALESCE(NULLIF(g->>'prefix', ''), t->>'prefix')));
      IF v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
        RAISE EXCEPTION 'team slug "%" is not valid', v_slug USING ERRCODE = 'P0006';
      END IF;
      IF v_prefix !~ '^[A-Z0-9]{1,10}$' THEN
        RAISE EXCEPTION 'team prefix "%" is not valid', v_prefix USING ERRCODE = 'P0006';
      END IF;
      IF EXISTS (SELECT 1 FROM public.team tm WHERE tm.workspace_id = p_dest AND tm.slug = v_slug) OR v_slug = ANY(v_slugs) THEN
        RAISE EXCEPTION 'team slug "%" is already taken in the destination' , v_slug USING ERRCODE = 'P0006';
      END IF;
      IF EXISTS (SELECT 1 FROM public.team tm WHERE tm.workspace_id = p_dest AND tm.issue_prefix = v_prefix) OR v_prefix = ANY(v_prefixes) THEN
        RAISE EXCEPTION 'team prefix "%" is already taken in the destination', v_prefix USING ERRCODE = 'P0006';
      END IF;
      v_slugs := v_slugs || v_slug;
      v_prefixes := v_prefixes || v_prefix;
      t := t || jsonb_build_object('mode', 'own', 'destination_team_id', NULL, 'name', v_name, 'slug', v_slug, 'prefix', v_prefix);
    ELSE
      RAISE EXCEPTION 'plan mode must be "own" or "fold"' USING ERRCODE = 'P0006';
    END IF;
    v_out := v_out || t;
  END LOOP;

  RETURN jsonb_build_object('teams', v_out, 'snapshot', p_plan->'snapshot');
END;
$$;

-- ============================================================
-- 5. The maps: what folds onto what. Built once per call (preflight or merge)
--    into transaction-local temp tables every step reads.
-- ============================================================

CREATE OR REPLACE FUNCTION public._wsmerge_build_maps(p_source uuid, p_dest uuid, p_plan jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  -- people in both workspaces: source member → destination member
  DROP TABLE IF EXISTS pg_temp._wsmerge_members;
  CREATE TABLE pg_temp._wsmerge_members (src uuid PRIMARY KEY, dst uuid NOT NULL, user_id uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_members
  SELECT s.id, d.id, s.user_id
  FROM public.member s
  JOIN public.member d ON d.user_id = s.user_id AND d.workspace_id = p_dest
  WHERE s.workspace_id = p_source;

  -- teams: own (dst = itself, renamed) or fold (dst = the chosen team)
  DROP TABLE IF EXISTS pg_temp._wsmerge_teams;
  CREATE TABLE pg_temp._wsmerge_teams (
    src uuid PRIMARY KEY, dst uuid NOT NULL, mode text NOT NULL,
    old_name text, new_name text, old_slug text, new_slug text,
    old_prefix text NOT NULL, new_prefix text NOT NULL, ord int
  ) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_teams
  SELECT t.id,
         CASE WHEN e.v->>'mode' = 'fold' THEN (e.v->>'destination_team_id')::uuid ELSE t.id END,
         e.v->>'mode',
         t.name, COALESCE(e.v->>'name', t.name),
         t.slug, COALESCE(e.v->>'slug', t.slug),
         t.issue_prefix,
         CASE WHEN e.v->>'mode' = 'fold'
              THEN (SELECT d.issue_prefix FROM public.team d WHERE d.id = (e.v->>'destination_team_id')::uuid)
              ELSE e.v->>'prefix' END,
         e.ord
  FROM jsonb_array_elements(p_plan->'teams') WITH ORDINALITY e(v, ord)
  JOIN public.team t ON t.id = (e.v->>'source_team_id')::uuid AND t.workspace_id = p_source;

  -- workflow states of folded teams: the engine ladder (name → category →
  -- default → first), so dst is never NULL (the plan already required a
  -- default state). Columns common to DEV and PROD only: PROD's
  -- workflow_state has no entity_kind.
  DROP TABLE IF EXISTS pg_temp._wsmerge_states;
  CREATE TABLE pg_temp._wsmerge_states (src uuid PRIMARY KEY, dst uuid) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_states
  SELECT s.id, COALESCE(
    (SELECT d.id FROM public.workflow_state d WHERE d.team_id = tm.dst AND lower(d.name) = lower(s.name) ORDER BY d.sort_order, d.id LIMIT 1),
    (SELECT d.id FROM public.workflow_state d WHERE d.team_id = tm.dst AND d.category = s.category ORDER BY d.sort_order, d.id LIMIT 1),
    (SELECT d.id FROM public.workflow_state d WHERE d.team_id = tm.dst AND d.is_default ORDER BY d.sort_order, d.id LIMIT 1),
    (SELECT d.id FROM public.workflow_state d WHERE d.team_id = tm.dst ORDER BY d.sort_order, d.id LIMIT 1))
  FROM public.workflow_state s
  JOIN pg_temp._wsmerge_teams tm ON tm.src = s.team_id AND tm.mode = 'fold';

  -- labels by name, case-insensitively (oldest destination twin wins)
  DROP TABLE IF EXISTS pg_temp._wsmerge_labels;
  CREATE TABLE pg_temp._wsmerge_labels (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_labels
  SELECT DISTINCT ON (s.id) s.id, d.id
  FROM public.label s
  JOIN public.label d ON d.workspace_id = p_dest AND lower(d.name) = lower(s.name)
  WHERE s.workspace_id = p_source
  ORDER BY s.id, d.created_at, d.id;

  -- system teammates by system_key
  DROP TABLE IF EXISTS pg_temp._wsmerge_teammates;
  CREATE TABLE pg_temp._wsmerge_teammates (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_teammates
  SELECT s.id, d.id
  FROM public.ai_team_member s
  JOIN public.ai_team_member d ON d.workspace_id = p_dest AND d.system_key = s.system_key
  WHERE s.workspace_id = p_source AND s.is_system AND s.system_key IS NOT NULL;

  -- contacts by email (both live, i.e. not already merged tombstones)
  DROP TABLE IF EXISTS pg_temp._wsmerge_contacts;
  CREATE TABLE pg_temp._wsmerge_contacts (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_contacts
  SELECT DISTINCT ON (s.id) s.id, d.id
  FROM public.contact s
  JOIN public.contact d ON d.workspace_id = p_dest AND d.email IS NOT NULL AND lower(d.email) = lower(s.email)
                        AND d.merged_into_contact_id IS NULL
  WHERE s.workspace_id = p_source AND s.email IS NOT NULL AND s.merged_into_contact_id IS NULL
  ORDER BY s.id, d.created_at, d.id;

  -- companies by domain
  DROP TABLE IF EXISTS pg_temp._wsmerge_companies;
  CREATE TABLE pg_temp._wsmerge_companies (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_companies
  SELECT DISTINCT ON (s.id) s.id, d.id
  FROM public.company s
  JOIN public.company d ON d.workspace_id = p_dest AND COALESCE(d.domain, '') <> '' AND lower(d.domain) = lower(s.domain)
  WHERE s.workspace_id = p_source AND COALESCE(s.domain, '') <> ''
  ORDER BY s.id, d.created_at, d.id;

  -- the per-person hidden '__default__' project, by person
  DROP TABLE IF EXISTS pg_temp._wsmerge_projects;
  CREATE TABLE pg_temp._wsmerge_projects (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_projects
  SELECT s.id, d.id
  FROM public.projects s
  JOIN public.projects d ON d.workspace_id = p_dest AND d.name = '__default__' AND d.user_id = s.user_id
  WHERE s.workspace_id = p_source AND s.name = '__default__';

  -- seeded loops by seed_key (the destination's keeps running)
  DROP TABLE IF EXISTS pg_temp._wsmerge_flows;
  CREATE TABLE pg_temp._wsmerge_flows (src uuid PRIMARY KEY, dst uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_flows
  SELECT s.id, d.id
  FROM public.flow s
  JOIN public.flow d ON d.workspace_id = p_dest AND d.seed_key = s.seed_key
  WHERE s.workspace_id = p_source AND s.seed_key IS NOT NULL;

  -- providers both sides have connected: the destination's wins
  DROP TABLE IF EXISTS pg_temp._wsmerge_shared_providers;
  CREATE TABLE pg_temp._wsmerge_shared_providers (kind text, provider text, PRIMARY KEY (kind, provider)) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_shared_providers
  SELECT 'tasks', s.provider FROM public.task_sync_state s
  WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.task_sync_state d WHERE d.workspace_id = p_dest AND d.provider = s.provider)
  GROUP BY s.provider;
  INSERT INTO pg_temp._wsmerge_shared_providers
  SELECT 'crm', s.provider FROM public.crm_sync_state s
  WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.crm_sync_state d WHERE d.workspace_id = p_dest AND d.provider = s.provider)
  GROUP BY s.provider;

  -- every id that changes meaning, for the JSON rewriters
  DROP TABLE IF EXISTS pg_temp._wsmerge_ids;
  CREATE TABLE pg_temp._wsmerge_ids (src uuid, dst uuid) ON COMMIT DROP;
  INSERT INTO pg_temp._wsmerge_ids
  SELECT src, dst FROM pg_temp._wsmerge_members
  UNION ALL SELECT src, dst FROM pg_temp._wsmerge_teams WHERE mode = 'fold'
  UNION ALL SELECT src, dst FROM pg_temp._wsmerge_states WHERE dst IS NOT NULL
  UNION ALL SELECT src, dst FROM pg_temp._wsmerge_labels
  UNION ALL SELECT src, dst FROM pg_temp._wsmerge_teammates
  UNION ALL SELECT src, dst FROM pg_temp._wsmerge_projects
  UNION ALL SELECT src, dst FROM pg_temp._wsmerge_flows;
END;
$$;

-- The tenancy gate. The route authenticated the actor; this is the
-- authorisation, re-checked inside the transaction: owner of both workspaces.
-- No membership on either side reads as 'not found' (the engine's anti-oracle).
CREATE OR REPLACE FUNCTION public._wsmerge_gate(p_source uuid, p_dest uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_src_role text; v_dst_role text;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_source = p_dest THEN
    RAISE EXCEPTION 'destination is the same workspace' USING ERRCODE = '22023';
  END IF;
  SELECT role INTO v_src_role FROM public.member WHERE workspace_id = p_source AND user_id = p_actor;
  SELECT role INTO v_dst_role FROM public.member WHERE workspace_id = p_dest AND user_id = p_actor;
  IF v_src_role IS NULL OR v_dst_role IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_src_role <> 'owner' OR v_dst_role <> 'owner' THEN
    RAISE EXCEPTION 'merging workspaces requires owning both of them' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Per-table row counts under a workspace (every table with a workspace_id
-- column, the workspace row and move history aside). Used by the preflight
-- and by the merge's record and final assertion.
CREATE OR REPLACE FUNCTION public._wsmerge_counts(p_workspace uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; n bigint; v_out jsonb := '{}'::jsonb;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
      AND c.table_name NOT IN ('workspace', 'workspace_move_log', 'workspace_merge')
    ORDER BY c.table_name
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE workspace_id = $1', r.table_name) INTO n USING p_workspace;
    IF n > 0 THEN
      v_out := v_out || jsonb_build_object(r.table_name, n);
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;

-- ============================================================
-- 6. Preflight: the same rules, read-only. Returns the plan the person sees.
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_workspace_preflight(
  p_source uuid,
  p_destination uuid,
  p_actor uuid,
  p_plan jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_src public.workspace%ROWTYPE;
  v_dst public.workspace%ROWTYPE;
  v_plan jsonb;
  v_busy jsonb;
  v_drift_src jsonb; v_drift_dst jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_people jsonb; v_teams jsonb := '[]'::jsonb; v_labels jsonb; v_integrations jsonb; v_collisions jsonb;
  tm record;
  v_reprefixed bigint; v_renumbered bigint; v_states jsonb; v_cycle_conflict boolean;
BEGIN
  PERFORM public._wsmerge_gate(p_source, p_destination, p_actor);
  SELECT * INTO v_src FROM public.workspace WHERE id = p_source;
  SELECT * INTO v_dst FROM public.workspace WHERE id = p_destination;

  v_plan := public._wsmerge_plan(p_source, p_destination, COALESCE(p_plan, '{}'::jsonb));
  PERFORM public._wsmerge_build_maps(p_source, p_destination, v_plan);

  -- blockers: the source is busy, or either side fails the sweep
  v_busy := public._wsmerge_busy(p_source);
  IF jsonb_array_length(v_busy->'live_captures') > 0
     OR (v_busy->>'agent_runs')::int > 0 OR (v_busy->>'flow_runs')::int > 0 OR (v_busy->>'tracked_jobs')::int > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'source_busy', 'detail', v_busy);
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('check', check_name, 'violations', violations)), '[]'::jsonb)
    INTO v_drift_src FROM public.workspace_integrity_sweep(p_source);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('check', check_name, 'violations', violations)), '[]'::jsonb)
    INTO v_drift_dst FROM public.workspace_integrity_sweep(p_destination);
  IF jsonb_array_length(v_drift_src) > 0 OR jsonb_array_length(v_drift_dst) > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'drift', 'source', v_drift_src, 'destination', v_drift_dst);
  END IF;

  -- people
  v_people := jsonb_build_object(
    'joining', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'member_id', m.id, 'user_id', m.user_id, 'display_name', m.display_name,
               'role', CASE WHEN m.role = 'owner' THEN 'admin' ELSE m.role END) ORDER BY m.created_at), '[]'::jsonb)
      FROM public.member m
      WHERE m.workspace_id = p_source AND NOT EXISTS (SELECT 1 FROM pg_temp._wsmerge_members x WHERE x.src = m.id)),
    'in_both', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'user_id', x.user_id, 'display_name', d.display_name,
               'source_role', s.role, 'destination_role', d.role,
               'role_after', CASE WHEN d.role = 'owner' THEN 'owner'
                                  WHEN s.role = 'owner' THEN 'admin'
                                  WHEN public._wsmerge_role_rank(s.role) > public._wsmerge_role_rank(d.role) THEN s.role
                                  ELSE d.role END) ORDER BY d.created_at), '[]'::jsonb)
      FROM pg_temp._wsmerge_members x
      JOIN public.member s ON s.id = x.src
      JOIN public.member d ON d.id = x.dst),
    'destination_members', (SELECT count(*) FROM public.member WHERE workspace_id = p_destination),
    'invites_moving', (
      SELECT count(*) FROM public.invite i
      WHERE i.workspace_id = p_source AND i.accepted_at IS NULL AND i.expires_at > now()
        AND NOT EXISTS (SELECT 1 FROM public.member dm JOIN auth.users u ON u.id = dm.user_id
                        WHERE dm.workspace_id = p_destination AND lower(u.email) = lower(i.email))
        AND NOT EXISTS (SELECT 1 FROM public.invite di WHERE di.workspace_id = p_destination AND di.accepted_at IS NULL
                        AND di.expires_at > now() AND lower(di.email) = lower(i.email))),
    'invites_dropped', (
      SELECT count(*) FROM public.invite i
      WHERE i.workspace_id = p_source AND (
        i.accepted_at IS NOT NULL OR i.expires_at <= now()
        OR EXISTS (SELECT 1 FROM public.member dm JOIN auth.users u ON u.id = dm.user_id
                   WHERE dm.workspace_id = p_destination AND lower(u.email) = lower(i.email))
        OR EXISTS (SELECT 1 FROM public.invite di WHERE di.workspace_id = p_destination AND di.accepted_at IS NULL
                   AND di.expires_at > now() AND lower(di.email) = lower(i.email))))
  );

  -- teams: the plan's rows plus what each choice does to identifiers,
  -- states and cycles
  FOR tm IN SELECT * FROM pg_temp._wsmerge_teams ORDER BY ord LOOP
    IF tm.mode = 'own' THEN
      SELECT count(*) FILTER (WHERE left(a.identifier, length(tm.old_prefix) + 1) = tm.old_prefix || '-' AND tm.new_prefix <> tm.old_prefix),
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM public.actions d WHERE d.workspace_id = p_destination
               AND d.identifier = CASE WHEN tm.new_prefix <> tm.old_prefix AND left(a.identifier, length(tm.old_prefix) + 1) = tm.old_prefix || '-'
                                       THEN tm.new_prefix || substring(a.identifier FROM length(tm.old_prefix) + 1)
                                       ELSE a.identifier END))
      INTO v_reprefixed, v_renumbered
      FROM public.actions a WHERE a.workspace_id = p_source AND a.team_id = tm.src;
      v_states := '[]'::jsonb;
      v_cycle_conflict := false;
    ELSE
      v_reprefixed := 0;
      SELECT count(*) INTO v_renumbered
      FROM public.actions a WHERE a.workspace_id = p_source AND a.team_id = tm.src
        AND EXISTS (SELECT 1 FROM public.actions d WHERE d.workspace_id = p_destination AND d.identifier = a.identifier);
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'from', s.name, 'to', d.name,
               'actions', (SELECT count(*) FROM public.actions a WHERE a.status_id = s.id AND a.workspace_id = p_source)
             ) ORDER BY s.sort_order), '[]'::jsonb)
      INTO v_states
      FROM pg_temp._wsmerge_states sm
      JOIN public.workflow_state s ON s.id = sm.src
      LEFT JOIN public.workflow_state d ON d.id = sm.dst
      WHERE s.team_id = tm.src AND (d.id IS NULL OR lower(d.name) <> lower(s.name));
      v_cycle_conflict := EXISTS (SELECT 1 FROM public.cycle c WHERE c.team_id = tm.src AND c.status = 'active')
                      AND EXISTS (SELECT 1 FROM public.cycle c WHERE c.team_id = tm.dst AND c.status = 'active');
    END IF;

    v_teams := v_teams || (
      (SELECT e.value FROM jsonb_array_elements(v_plan->'teams') e WHERE (e.value->>'source_team_id')::uuid = tm.src)
      || jsonb_build_object(
           'identifiers', jsonb_build_object('reprefixed', v_reprefixed, 'renumbered', v_renumbered),
           'states_remapped', v_states,
           'active_cycle_conflict', v_cycle_conflict,
           'destination_team', CASE WHEN tm.mode = 'fold'
             THEN (SELECT jsonb_build_object('id', d.id, 'name', d.name, 'prefix', d.issue_prefix) FROM public.team d WHERE d.id = tm.dst)
             ELSE NULL END));
  END LOOP;

  v_labels := jsonb_build_object(
    'matched', (SELECT count(*) FROM pg_temp._wsmerge_labels),
    'created', (SELECT count(*) FROM public.label l WHERE l.workspace_id = p_source
                AND NOT EXISTS (SELECT 1 FROM pg_temp._wsmerge_labels x WHERE x.src = l.id)));

  v_integrations := jsonb_build_object(
    'tasks', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'provider', p.provider,
        'source', EXISTS (SELECT 1 FROM public.task_sync_state s WHERE s.workspace_id = p_source AND s.provider = p.provider),
        'destination', EXISTS (SELECT 1 FROM public.task_sync_state d WHERE d.workspace_id = p_destination AND d.provider = p.provider),
        'outcome', CASE WHEN EXISTS (SELECT 1 FROM pg_temp._wsmerge_shared_providers sp WHERE sp.kind = 'tasks' AND sp.provider = p.provider)
                        THEN 'destination_wins' ELSE 'moves' END,
        'links_severed', CASE WHEN EXISTS (SELECT 1 FROM pg_temp._wsmerge_shared_providers sp WHERE sp.kind = 'tasks' AND sp.provider = p.provider)
                              THEN (SELECT count(*) FROM public.action_external_task x WHERE x.workspace_id = p_source AND x.provider = p.provider)
                              ELSE 0 END) ORDER BY p.provider), '[]'::jsonb)
      FROM (SELECT provider FROM public.task_sync_state WHERE workspace_id IN (p_source, p_destination) GROUP BY provider) p),
    'crm', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'provider', p.provider,
        'source', EXISTS (SELECT 1 FROM public.crm_sync_state s WHERE s.workspace_id = p_source AND s.provider = p.provider),
        'destination', EXISTS (SELECT 1 FROM public.crm_sync_state d WHERE d.workspace_id = p_destination AND d.provider = p.provider),
        'outcome', CASE WHEN EXISTS (SELECT 1 FROM pg_temp._wsmerge_shared_providers sp WHERE sp.kind = 'crm' AND sp.provider = p.provider)
                        THEN 'destination_wins' ELSE 'moves' END,
        'provider_ids_cleared', CASE WHEN EXISTS (SELECT 1 FROM pg_temp._wsmerge_shared_providers sp WHERE sp.kind = 'crm' AND sp.provider = p.provider)
                                     THEN (SELECT count(*) FROM public.contact c WHERE c.workspace_id = p_source AND c.source_provider = p.provider AND c.provider_contact_id IS NOT NULL)
                                        + (SELECT count(*) FROM public.company c WHERE c.workspace_id = p_source AND c.source_provider = p.provider AND c.provider_company_id IS NOT NULL)
                                     ELSE 0 END) ORDER BY p.provider), '[]'::jsonb)
      FROM (SELECT provider FROM public.crm_sync_state WHERE workspace_id IN (p_source, p_destination) GROUP BY provider) p),
    'connected_accounts', (SELECT count(*) FROM public.connected_account a WHERE a.workspace_id = p_source),
    'account_links', (SELECT count(*) FROM public.connected_account_workspace j WHERE j.workspace_id = p_source),
    'mcp_servers', (SELECT count(*) FROM public.connected_mcp_server s WHERE s.workspace_id = p_source),
    'cloud_environments', (SELECT count(*) FROM public.cloud_environment e WHERE e.workspace_id = p_source),
    'github_prs', (SELECT count(*) FROM public.action_github_pr x WHERE x.workspace_id = p_source));

  v_collisions := jsonb_build_object(
    'contacts_folded', (SELECT count(*) FROM pg_temp._wsmerge_contacts),
    'companies_folded', (SELECT count(*) FROM pg_temp._wsmerge_companies),
    'workspace_company_demoted', EXISTS (
      SELECT 1 FROM public.company s WHERE s.workspace_id = p_source AND s.is_workspace_company
        AND NOT EXISTS (SELECT 1 FROM pg_temp._wsmerge_companies x WHERE x.src = s.id)
        AND EXISTS (SELECT 1 FROM public.company d WHERE d.workspace_id = p_destination AND d.is_workspace_company)),
    'documents_canon_demoted', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'canon_key', s.canon_key) ORDER BY s.title), '[]'::jsonb)
      FROM public.document s
      WHERE s.workspace_id = p_source AND s.canon_key IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.document d WHERE d.workspace_id = p_destination AND d.canon_key = s.canon_key
          AND (s.canon_key !~ '^(person|content-brief):'
               OR d.created_by IS NOT DISTINCT FROM COALESCE((SELECT x.dst FROM pg_temp._wsmerge_members x WHERE x.src = s.created_by), s.created_by)))),
    'documents_reslugged', (SELECT count(*) FROM public.document s WHERE s.workspace_id = p_source AND s.slug IS NOT NULL
                            AND EXISTS (SELECT 1 FROM public.document d WHERE d.workspace_id = p_destination AND d.slug = s.slug)),
    'views_reslugged', (SELECT count(*) FROM public.view s WHERE s.workspace_id = p_source AND s.slug IS NOT NULL
                        AND EXISTS (SELECT 1 FROM public.view d WHERE d.workspace_id = p_destination AND d.slug = s.slug)),
    'recipes_reslugged', (SELECT count(*) FROM public.recipe s WHERE s.workspace_id = p_source AND s.slug IS NOT NULL
                          AND EXISTS (SELECT 1 FROM public.recipe d WHERE d.workspace_id = p_destination AND d.slug = s.slug)),
    'packages_reslugged', (SELECT count(*) FROM public.knowledge_package s WHERE s.workspace_id = p_source
                           AND EXISTS (SELECT 1 FROM public.knowledge_package d WHERE d.workspace_id = p_destination AND d.slug = s.slug)),
    'prospect_lists_renamed', (SELECT count(*) FROM public.prospect_list s WHERE s.workspace_id = p_source
                               AND EXISTS (SELECT 1 FROM public.prospect_list d WHERE d.workspace_id = p_destination AND lower(d.name) = lower(s.name))),
    'home_threads_demoted', (SELECT count(*) FROM public.chat_conversations s WHERE s.workspace_id = p_source AND s.is_home
                             AND EXISTS (SELECT 1 FROM public.chat_conversations d WHERE d.workspace_id = p_destination AND d.is_home AND d.user_id = s.user_id)),
    'teammate_threads_demoted', (SELECT count(*) FROM public.chat_conversations s JOIN pg_temp._wsmerge_teammates t ON t.src = s.ai_team_member_id
                                 WHERE s.workspace_id = p_source
                                 AND EXISTS (SELECT 1 FROM public.chat_conversations d WHERE d.user_id = s.user_id AND d.ai_team_member_id = t.dst)),
    'system_teammates_folded', (SELECT count(*) FROM pg_temp._wsmerge_teammates),
    'seeded_flows_dropped', (SELECT count(*) FROM pg_temp._wsmerge_flows),
    'default_projects_folded', (SELECT count(*) FROM pg_temp._wsmerge_projects),
    'thread_copies_folded', (SELECT count(*) FROM public.email_thread_index s WHERE s.workspace_id = p_source
                             AND EXISTS (SELECT 1 FROM public.email_thread_index d WHERE d.workspace_id = p_destination
                                         AND COALESCE(d.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
                                         AND d.provider_thread_id = s.provider_thread_id)),
    'account_links_deduped', (SELECT count(*) FROM public.connected_account_workspace s WHERE s.workspace_id = p_source
                              AND EXISTS (SELECT 1 FROM public.connected_account_workspace d WHERE d.workspace_id = p_destination AND d.account_id = s.account_id)),
    'sequence_enrollments_exited', (
      SELECT count(*) FROM public.sequence_enrollment s WHERE s.workspace_id = p_source AND s.status = 'active'
        AND EXISTS (SELECT 1 FROM public.sequence_enrollment d WHERE d.workspace_id = p_destination AND d.status = 'active'
                    AND (d.contact_id = COALESCE((SELECT c.dst FROM pg_temp._wsmerge_contacts c WHERE c.src = s.contact_id), s.contact_id)
                         OR lower(d.contact_email) = lower(s.contact_email)))),
    'singletons_dropped', jsonb_build_object(
      'mail_review_activity', (SELECT count(*) FROM public.mail_review_activity s WHERE s.workspace_id = p_source
                               AND EXISTS (SELECT 1 FROM public.mail_review_activity d WHERE d.workspace_id = p_destination AND d.user_id = s.user_id)),
      'meeting_goal', (SELECT count(*) FROM public.meeting_goal s WHERE s.workspace_id = p_source
                       AND EXISTS (SELECT 1 FROM public.meeting_goal d WHERE d.workspace_id = p_destination AND d.user_id = s.user_id
                                   AND d.calendar_event_id = s.calendar_event_id AND d.starts_at = s.starts_at)),
      'agent_log', (SELECT count(*) FROM public.agent_log s WHERE s.workspace_id = p_source
                    AND EXISTS (SELECT 1 FROM public.agent_log d WHERE d.workspace_id = p_destination AND d.user_id = s.user_id AND d.dedupe_key = s.dedupe_key)),
      'agent_event', (SELECT count(*) FROM public.agent_event s WHERE s.workspace_id = p_source
                      AND EXISTS (SELECT 1 FROM public.agent_event d WHERE d.workspace_id = p_destination AND d.user_id = s.user_id AND d.dedupe_key = s.dedupe_key)),
      'eval_candidate', (SELECT count(*) FROM public.eval_candidate s WHERE s.workspace_id = p_source
                         AND EXISTS (SELECT 1 FROM public.eval_candidate d WHERE d.workspace_id = p_destination AND d.user_id = s.user_id AND d.dedupe_key = s.dedupe_key)),
      'reminders', (SELECT count(*) FROM public.reminder s WHERE s.workspace_id = p_source AND s.delivered_at IS NULL
                    AND EXISTS (SELECT 1 FROM public.reminder d WHERE d.workspace_id = p_destination AND d.delivered_at IS NULL
                                AND d.user_id = s.user_id AND d.entity_type = s.entity_type AND d.entity_id = s.entity_id))));

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_blockers) = 0,
    'blockers', v_blockers,
    'source', jsonb_build_object('id', v_src.id, 'name', v_src.name, 'slug', v_src.slug, 'created_at', v_src.created_at),
    'destination', jsonb_build_object('id', v_dst.id, 'name', v_dst.name, 'slug', v_dst.slug),
    'busy', v_busy,
    'drift', jsonb_build_object('source', v_drift_src, 'destination', v_drift_dst),
    'people', v_people,
    'teams', v_teams,
    'labels', v_labels,
    'integrations', v_integrations,
    'collisions', v_collisions,
    'counts', public._wsmerge_counts(p_source),
    'plan', v_plan
  );
END;
$$;

-- ============================================================
-- 7. The steps. Each takes (source, destination), reads the maps, writes,
--    and returns its counts. merge_workspace runs them in this order.
-- ============================================================

-- A polymorphic (type, id) that folds onto another id: every table that
-- stores such a pair follows, with its uniqueness respected.
CREATE OR REPLACE FUNCTION public._wsmerge_repoint_entity(p_type text, p_src uuid, p_dst uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  -- evidence (unique claim_id, source_type, source_id, source_uri)
  DELETE FROM public.claim_source s
  WHERE s.source_type = p_type AND s.source_id = p_src
    AND EXISTS (SELECT 1 FROM public.claim_source d WHERE d.claim_id = s.claim_id AND d.source_type = p_type
                AND d.source_id = p_dst AND d.source_uri IS NOT DISTINCT FROM s.source_uri);
  UPDATE public.claim_source SET source_id = p_dst WHERE source_type = p_type AND source_id = p_src;

  -- edges (six-column key): re-point where that edge is new, drop the rest
  UPDATE public.entity_link l SET source_id = p_dst
  WHERE l.source_type = p_type AND l.source_id = p_src
    AND NOT EXISTS (SELECT 1 FROM public.entity_link d WHERE d.workspace_id = l.workspace_id AND d.source_type = p_type AND d.source_id = p_dst
                    AND d.target_type = l.target_type AND d.target_id = l.target_id AND d.relation = l.relation);
  DELETE FROM public.entity_link WHERE source_type = p_type AND source_id = p_src;
  UPDATE public.entity_link l SET target_id = p_dst
  WHERE l.target_type = p_type AND l.target_id = p_src
    AND NOT EXISTS (SELECT 1 FROM public.entity_link d WHERE d.workspace_id = l.workspace_id AND d.target_type = p_type AND d.target_id = p_dst
                    AND d.source_type = l.source_type AND d.source_id = l.source_id AND d.relation = l.relation);
  DELETE FROM public.entity_link WHERE target_type = p_type AND target_id = p_src;

  -- package pins (PK package_id, entity_type, entity_id)
  INSERT INTO public.knowledge_package_item (package_id, workspace_id, entity_type, entity_id, added_by, created_at)
  SELECT package_id, workspace_id, entity_type, p_dst, added_by, created_at
  FROM public.knowledge_package_item WHERE entity_type = p_type AND entity_id = p_src
  ON CONFLICT DO NOTHING;
  DELETE FROM public.knowledge_package_item WHERE entity_type = p_type AND entity_id = p_src;

  UPDATE public.work_touch SET entity_id = p_dst WHERE entity_type = p_type AND entity_id = p_src;
  UPDATE public.notification SET target_id = p_dst WHERE target_type = p_type AND target_id = p_src;
  UPDATE public.notification SET context_id = p_dst WHERE context_type = p_type AND context_id = p_src;
  UPDATE public.attention_item SET entity_id = p_dst WHERE entity_type = p_type AND entity_id = p_src;

  -- pending reminders: one per person per entity
  DELETE FROM public.reminder s
  WHERE s.entity_type = p_type AND s.entity_id = p_src AND s.delivered_at IS NULL
    AND EXISTS (SELECT 1 FROM public.reminder d WHERE d.user_id = s.user_id AND d.entity_type = p_type AND d.entity_id = p_dst AND d.delivered_at IS NULL);
  UPDATE public.reminder SET entity_id = p_dst WHERE entity_type = p_type AND entity_id = p_src;

  IF p_type IN ('action', 'capture', 'document', 'project', 'contact') THEN
    UPDATE public.comment SET commentable_id = p_dst WHERE commentable_type::text = p_type AND commentable_id = p_src;
  END IF;
END;
$$;

-- People. Rule: everyone comes along. A person already in the destination
-- keeps their destination row (which absorbs the higher role, owner excepted,
-- and fills its blanks); every reference to their source row is translated,
-- then the source row goes. Everyone else's row re-stamps (the source owner
-- becomes an admin). Pending invites move with their tokens unless the person
-- is already in, or invited to, the destination.
CREATE OR REPLACE FUNCTION public._wsmerge_members(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_folded int := 0; v_moved int := 0; v_invites_moved int := 0; v_invites_dropped int := 0;
BEGIN
  UPDATE public.member d
  SET role = CASE WHEN d.role = 'owner' THEN 'owner'
                  WHEN s.role = 'owner' THEN 'admin'
                  WHEN public._wsmerge_role_rank(s.role) > public._wsmerge_role_rank(d.role) THEN s.role
                  ELSE d.role END,
      avatar_url = COALESCE(d.avatar_url, s.avatar_url),
      time_zone = COALESCE(d.time_zone, s.time_zone),
      onboarding_completed_at = COALESCE(d.onboarding_completed_at, s.onboarding_completed_at)
  FROM pg_temp._wsmerge_members x
  JOIN public.member s ON s.id = x.src
  WHERE d.id = x.dst;

  -- plain pointers
  UPDATE public.actions t SET assignee_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.assignee_id = x.src;
  UPDATE public.campaign t SET owner_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_member_id = x.src;
  UPDATE public.capture_participant t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.claim t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.claim t SET subject_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.subject_member_id = x.src;
  UPDATE public.comment t SET author_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.author_id = x.src;
  UPDATE public.contact t SET created_by_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by_member_id = x.src;
  UPDATE public.contact t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  IF to_regclass('public.deal') IS NOT NULL THEN
    EXECUTE 'UPDATE public.deal t SET owner_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_id = x.src';
  END IF;
  UPDATE public.decision t SET decided_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.decided_by = x.src;
  UPDATE public.document t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.document t SET last_edited_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.last_edited_by = x.src;
  UPDATE public.document_revision t SET author_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.author_id = x.src;
  UPDATE public.document_section_check t SET verified_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.verified_by = x.src;
  UPDATE public.entity_link t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.initiative t SET owner_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_id = x.src;
  UPDATE public.invite t SET invited_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.invited_by = x.src;
  UPDATE public.lens_finding t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.notification t SET actor_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.actor_id = x.src;
  UPDATE public.notification t SET recipient_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.recipient_id = x.src;
  UPDATE public.projects t SET lead_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.lead_id = x.src;
  UPDATE public.proposed_change t SET applied_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.applied_by = x.src;
  UPDATE public.proposed_change t SET assignee_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.assignee_member_id = x.src;
  UPDATE public.share t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.tool_approval t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.tracked_job t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.attention_item t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.contact_share t SET shared_by_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.shared_by_member_id = x.src;
  IF to_regclass('public.slack_user_link') IS NOT NULL THEN
    EXECUTE 'UPDATE public.slack_user_link t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src';
  END IF;

  -- junctions unique on the member: translate where free, drop the duplicate
  UPDATE public.team_member t SET member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.team_member y WHERE y.team_id = t.team_id AND y.member_id = x.dst);
  DELETE FROM public.team_member t USING pg_temp._wsmerge_members x WHERE t.member_id = x.src;

  UPDATE public.action_assignee t SET member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.action_assignee y WHERE y.action_id = t.action_id AND y.member_id = x.dst);
  DELETE FROM public.action_assignee t USING pg_temp._wsmerge_members x WHERE t.member_id = x.src;

  UPDATE public.contact_share t SET shared_with_member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.shared_with_member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.contact_share y WHERE y.contact_id = t.contact_id AND y.shared_with_member_id = x.dst);
  DELETE FROM public.contact_share t USING pg_temp._wsmerge_members x WHERE t.shared_with_member_id = x.src;

  UPDATE public.knowledge_package_share t SET shared_with_member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.shared_with_member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.knowledge_package_share y WHERE y.package_id = t.package_id AND y.shared_with_member_id = x.dst);
  DELETE FROM public.knowledge_package_share t USING pg_temp._wsmerge_members x WHERE t.shared_with_member_id = x.src;

  UPDATE public.document_draft t SET author_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.author_id = x.src AND NOT EXISTS (SELECT 1 FROM public.document_draft y WHERE y.document_id = t.document_id AND y.author_id = x.dst);
  DELETE FROM public.document_draft t USING pg_temp._wsmerge_members x WHERE t.author_id = x.src;

  -- the folded rows go: nothing of theirs is left for the departure triggers
  DELETE FROM public.member m USING pg_temp._wsmerge_members x WHERE m.id = x.src;
  GET DIAGNOSTICS v_folded = ROW_COUNT;

  UPDATE public.member
  SET workspace_id = p_dest, role = CASE WHEN role = 'owner' THEN 'admin' ELSE role END
  WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  DELETE FROM public.invite i
  WHERE i.workspace_id = p_source AND (
    i.accepted_at IS NOT NULL OR i.expires_at <= now()
    OR EXISTS (SELECT 1 FROM public.member dm JOIN auth.users u ON u.id = dm.user_id
               WHERE dm.workspace_id = p_dest AND lower(u.email) = lower(i.email))
    OR EXISTS (SELECT 1 FROM public.invite di WHERE di.workspace_id = p_dest AND di.accepted_at IS NULL
               AND di.expires_at > now() AND lower(di.email) = lower(i.email)));
  GET DIAGNOSTICS v_invites_dropped = ROW_COUNT;
  UPDATE public.invite SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_invites_moved = ROW_COUNT;

  RETURN jsonb_build_object('members_folded', v_folded, 'members_moved', v_moved,
                            'invites_moved', v_invites_moved, 'invites_dropped', v_invites_dropped);
END;
$$;

-- System teammates. Rule: the six built-in teammates exist once per
-- workspace; the source's fold onto the destination's twins (every pointer
-- re-points, a person's duplicate teammate thread becomes a plain
-- conversation), then the source rows go.
CREATE OR REPLACE FUNCTION public._wsmerge_system_teammates(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_src_name text; v_folded int := 0; v_threads_demoted int := 0;
BEGIN
  SELECT name INTO v_src_name FROM public.workspace WHERE id = p_source;

  UPDATE public.chat_conversations c
  SET ai_team_member_id = NULL, title = COALESCE(NULLIF(c.title, ''), 'Chat') || ' · ' || v_src_name
  FROM pg_temp._wsmerge_teammates t
  WHERE c.ai_team_member_id = t.src
    AND EXISTS (SELECT 1 FROM public.chat_conversations d WHERE d.user_id = c.user_id AND d.ai_team_member_id = t.dst);
  GET DIAGNOSTICS v_threads_demoted = ROW_COUNT;

  UPDATE public.chat_conversations c SET ai_team_member_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE c.ai_team_member_id = t.src;
  UPDATE public.chat_conversations c SET agent_teammate_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE c.agent_teammate_id = t.src;
  UPDATE public.agent_memory m SET ai_team_member_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE m.ai_team_member_id = t.src;
  UPDATE public.flow f SET ai_team_member_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE f.ai_team_member_id = t.src;
  UPDATE public.tracked_job j SET ai_team_member_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE j.ai_team_member_id = t.src;
  UPDATE public.agent_run r SET ai_team_member_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE r.ai_team_member_id = t.src;
  UPDATE public.bot_relay b SET teammate_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE b.teammate_id = t.src;
  UPDATE public.actions a SET assignee_ai_member_id = t.dst FROM pg_temp._wsmerge_teammates t WHERE a.assignee_ai_member_id = t.src;

  INSERT INTO public.ai_team_member_skill (ai_team_member_id, skill_recipe_id, sort_order)
  SELECT t.dst, s.skill_recipe_id, s.sort_order
  FROM public.ai_team_member_skill s JOIN pg_temp._wsmerge_teammates t ON t.src = s.ai_team_member_id
  ON CONFLICT DO NOTHING;
  DELETE FROM public.ai_team_member_skill s USING pg_temp._wsmerge_teammates t WHERE s.ai_team_member_id = t.src;

  DELETE FROM public.ai_team_member a USING pg_temp._wsmerge_teammates t WHERE a.id = t.src;
  GET DIAGNOSTICS v_folded = ROW_COUNT;

  RETURN jsonb_build_object('system_teammates_folded', v_folded, 'teammate_threads_demoted', v_threads_demoted);
END;
$$;

-- Teams, first half. Rule: a team arriving as its own re-stamps now, under
-- its (possibly new) name, slug and prefix, so everything on it can follow.
-- Folded teams are deleted at the end, once nothing points at them.
CREATE OR REPLACE FUNCTION public._wsmerge_teams_begin(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_own int := 0;
BEGIN
  UPDATE public.team t
  SET workspace_id = p_dest, name = m.new_name, slug = m.new_slug, issue_prefix = m.new_prefix
  FROM pg_temp._wsmerge_teams m
  WHERE t.id = m.src AND m.mode = 'own';
  GET DIAGNOSTICS v_own = ROW_COUNT;
  RETURN jsonb_build_object('teams_own', v_own,
                            'teams_folded', (SELECT count(*) FROM pg_temp._wsmerge_teams WHERE mode = 'fold'));
END;
$$;

-- Labels. Rule: union by name, case-insensitively. A source label with a
-- destination twin folds onto it (junctions re-point, duplicates drop, the
-- twin absorbs scopes); every other label arrives as it is.
CREATE OR REPLACE FUNCTION public._wsmerge_labels(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE j record; v_folded int := 0; v_moved int := 0;
BEGIN
  FOR j IN SELECT * FROM (VALUES
      ('action_label', 'action_id'), ('capture_label', 'capture_id'), ('project_label', 'project_id'),
      ('initiative_label', 'initiative_id'), ('email_thread_label', 'thread_id')) AS v(junction, col)
  LOOP
    EXECUTE format($q$
      UPDATE public.%1$I x SET label_id = m.dst
      FROM pg_temp._wsmerge_labels m
      WHERE x.label_id = m.src
        AND NOT EXISTS (SELECT 1 FROM public.%1$I y WHERE y.%2$I = x.%2$I AND y.label_id = m.dst)
    $q$, j.junction, j.col);
    EXECUTE format($q$
      DELETE FROM public.%1$I x USING pg_temp._wsmerge_labels m WHERE x.label_id = m.src
    $q$, j.junction);
  END LOOP;

  UPDATE public.label d
  SET scopes = (SELECT array_agg(DISTINCT e) FROM unnest(COALESCE(d.scopes, '{}'::text[]) || COALESCE(s.scopes, '{}'::text[])) e),
      group_name = COALESCE(d.group_name, s.group_name)
  FROM pg_temp._wsmerge_labels m
  JOIN public.label s ON s.id = m.src
  WHERE d.id = m.dst;

  DELETE FROM public.label l USING pg_temp._wsmerge_labels m WHERE l.id = m.src;
  GET DIAGNOSTICS v_folded = ROW_COUNT;
  UPDATE public.label SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  RETURN jsonb_build_object('labels_folded', v_folded, 'labels_moved', v_moved);
END;
$$;

-- Integrations. Rule: a provider only the source has comes over whole (the
-- generic re-stamp carries its sync state and links). One both sides have
-- keeps the destination's: the source's links are severed with the URL kept
-- on the action (221's shape and reason: a Jira issue id is per site), its
-- sync state goes, and portal ids from the dropped CRM portal are cleared
-- into metadata. The HubSpot settings flags travel only when the destination
-- has no HubSpot of its own.
CREATE OR REPLACE FUNCTION public._wsmerge_integrations(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_severed int := 0; v_task_states int := 0; v_crm_states int := 0; v_ids_cleared int := 0; n int;
BEGIN
  WITH severed AS (
    DELETE FROM public.action_external_task t
    USING pg_temp._wsmerge_shared_providers sp
    WHERE sp.kind = 'tasks' AND sp.provider = t.provider AND t.workspace_id = p_source
    RETURNING t.action_id, t.provider, t.external_url, t.external_title
  ),
  link_rows AS (
    SELECT action_id,
           jsonb_agg(jsonb_build_object('url', external_url, 'title', COALESCE(external_title, initcap(provider) || ' task')))
             FILTER (WHERE external_url IS NOT NULL) AS new_links,
           count(*) AS severed_n
    FROM severed GROUP BY action_id
  ),
  appended AS (
    UPDATE public.actions a
    SET links = CASE WHEN lr.new_links IS NULL THEN a.links
                     WHEN a.links IS NULL OR jsonb_typeof(a.links) <> 'array' THEN lr.new_links
                     ELSE a.links || lr.new_links END
    FROM link_rows lr WHERE a.id = lr.action_id
    RETURNING lr.severed_n
  )
  SELECT COALESCE(sum(ap.severed_n), 0)::int INTO v_severed FROM appended ap;

  DELETE FROM public.task_sync_state t USING pg_temp._wsmerge_shared_providers sp
  WHERE sp.kind = 'tasks' AND sp.provider = t.provider AND t.workspace_id = p_source;
  GET DIAGNOSTICS v_task_states = ROW_COUNT;

  UPDATE public.contact c
  SET metadata = COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object('provider_unlinked',
        jsonb_build_object('provider', c.source_provider, 'provider_contact_id', c.provider_contact_id, 'reason', 'workspace_merge')),
      provider_contact_id = NULL, source_provider = NULL
  FROM pg_temp._wsmerge_shared_providers sp
  WHERE sp.kind = 'crm' AND sp.provider = c.source_provider AND c.workspace_id = p_source AND c.provider_contact_id IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; v_ids_cleared := v_ids_cleared + n;

  UPDATE public.company c
  SET metadata = COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object('provider_unlinked',
        jsonb_build_object('provider', c.source_provider, 'provider_company_id', c.provider_company_id, 'reason', 'workspace_merge')),
      provider_company_id = NULL, source_provider = NULL
  FROM pg_temp._wsmerge_shared_providers sp
  WHERE sp.kind = 'crm' AND sp.provider = c.source_provider AND c.workspace_id = p_source AND c.provider_company_id IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; v_ids_cleared := v_ids_cleared + n;

  DELETE FROM public.crm_sync_state t USING pg_temp._wsmerge_shared_providers sp
  WHERE sp.kind = 'crm' AND sp.provider = t.provider AND t.workspace_id = p_source;
  GET DIAGNOSTICS v_crm_states = ROW_COUNT;

  IF EXISTS (SELECT 1 FROM public.crm_sync_state WHERE workspace_id = p_source AND provider = 'hubspot')
     AND NOT EXISTS (SELECT 1 FROM public.crm_sync_state WHERE workspace_id = p_dest AND provider = 'hubspot') THEN
    UPDATE public.workspace d
    SET settings = COALESCE(d.settings, '{}'::jsonb) || (
      SELECT jsonb_strip_nulls(jsonb_build_object(
        'log_meetings_to_hubspot', s.settings->'log_meetings_to_hubspot',
        'push_contacts_to_hubspot', s.settings->'push_contacts_to_hubspot',
        'push_contacts_scope', s.settings->'push_contacts_scope'))
      FROM public.workspace s WHERE s.id = p_source)
    WHERE d.id = p_dest;
  END IF;

  RETURN jsonb_build_object('external_links_severed', v_severed, 'task_sync_states_dropped', v_task_states,
                            'crm_sync_states_dropped', v_crm_states, 'provider_ids_cleared', v_ids_cleared);
END;
$$;

-- The hidden per-person '__default__' project. Rule: a person in both
-- workspaces has one in each; the source's folds onto the destination's.
CREATE OR REPLACE FUNCTION public._wsmerge_default_projects(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; v_folded int := 0;
BEGIN
  FOR r IN SELECT * FROM pg_temp._wsmerge_projects LOOP
    UPDATE public.actions SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.milestone SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.document SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.document_chunks SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.captures SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.capture_chunks SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.capture_references SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.attachments SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.attachment_chunks SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.proposed_change SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.decision SET project_id = r.dst WHERE project_id = r.src;
    UPDATE public.projects SET parent_project_id = r.dst WHERE parent_project_id = r.src;
    UPDATE public.email_thread_index SET linked_project_id = r.dst WHERE linked_project_id = r.src;
    UPDATE public.claim SET project_ids = (SELECT COALESCE(array_agg(DISTINCT e), '{}'::uuid[]) FROM unnest(array_replace(project_ids, r.src, r.dst)) e)
    WHERE project_ids @> ARRAY[r.src];
    INSERT INTO public.project_label (project_id, label_id, created_at)
    SELECT r.dst, label_id, created_at FROM public.project_label WHERE project_id = r.src
    ON CONFLICT DO NOTHING;
    DELETE FROM public.project_label WHERE project_id = r.src;
    DELETE FROM public.knowledge_brief WHERE scope_type = 'project' AND scope_id = r.src;
    DELETE FROM public.anchor_embedding WHERE entity_type = 'project' AND entity_id = r.src;
    DELETE FROM public.view WHERE scope_type = 'project' AND scope_id = r.src;
    PERFORM public._wsmerge_repoint_entity('project', r.src, r.dst);
    DELETE FROM public.projects WHERE id = r.src;
    v_folded := v_folded + 1;
  END LOOP;
  RETURN jsonb_build_object('default_projects_folded', v_folded);
END;
$$;

-- Actions. Rule, per source team: on its own team the action keeps its
-- identifier, re-prefixed only when the team's prefix changed (GEN-12 →
-- COH-12, number kept); into a folded team it keeps its identifier when that
-- is free in the destination and is renumbered from the watermark only on
-- collision (221's rule), with its status mapped by the ladder. The old
-- handle always lands in previous_identifier. Assignees, AI assignees and
-- contact assignees follow their maps; everything else on the row stays.
CREATE OR REPLACE FUNCTION public._wsmerge_actions(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  tm record;
  v_rewrite boolean; v_counter int; v_base int;
  v_moved bigint; v_renumbered bigint; v_reprefixed bigint; v_map jsonb;
  v_total bigint := 0; v_total_renumbered bigint := 0; v_total_reprefixed bigint := 0; v_identifier_map jsonb := '{}'::jsonb;
BEGIN
  FOR tm IN SELECT * FROM pg_temp._wsmerge_teams ORDER BY ord LOOP
    v_rewrite := (tm.mode = 'own' AND tm.new_prefix <> tm.old_prefix);

    SELECT t.issue_counter INTO v_counter FROM public.team t WHERE t.id = tm.dst FOR UPDATE;

    DROP TABLE IF EXISTS pg_temp._wsmerge_cand;
    CREATE TEMP TABLE _wsmerge_cand ON COMMIT DROP AS
      SELECT a.id, a.identifier AS old_identifier, a.created_at,
             CASE WHEN v_rewrite AND left(a.identifier, length(tm.old_prefix) + 1) = tm.old_prefix || '-'
                  THEN tm.new_prefix || substring(a.identifier FROM length(tm.old_prefix) + 1)
                  ELSE a.identifier END AS candidate
      FROM public.actions a
      WHERE a.workspace_id = p_source AND a.team_id = tm.src;

    -- the watermark for the (new) prefix: counter, highest number already in
    -- the destination, highest number arriving
    SELECT GREATEST(
      COALESCE(v_counter, 0),
      COALESCE((SELECT max(substring(d.identifier FROM length(tm.new_prefix) + 2)::bigint) FROM public.actions d
                WHERE d.workspace_id = p_dest AND left(d.identifier, length(tm.new_prefix) + 1) = tm.new_prefix || '-'
                  AND substring(d.identifier FROM length(tm.new_prefix) + 2) ~ '^[0-9]{1,9}$'), 0),
      COALESCE((SELECT max(substring(c.candidate FROM length(tm.new_prefix) + 2)::bigint) FROM pg_temp._wsmerge_cand c
                WHERE left(c.candidate, length(tm.new_prefix) + 1) = tm.new_prefix || '-'
                  AND substring(c.candidate FROM length(tm.new_prefix) + 2) ~ '^[0-9]{1,9}$'), 0)
    )::int INTO v_base;

    WITH colliding AS (
      SELECT c.id, row_number() OVER (ORDER BY c.created_at, c.id) AS rn
      FROM pg_temp._wsmerge_cand c
      WHERE EXISTS (SELECT 1 FROM public.actions d WHERE d.workspace_id = p_dest AND d.identifier = c.candidate)
         OR EXISTS (SELECT 1 FROM pg_temp._wsmerge_cand c2 WHERE c2.candidate = c.candidate AND (c2.created_at, c2.id) < (c.created_at, c.id))
    ),
    moved AS (
      UPDATE public.actions a
      SET workspace_id = p_dest,
          team_id = tm.dst,
          identifier = CASE WHEN col.id IS NOT NULL THEN tm.new_prefix || '-' || (v_base + col.rn) ELSE c.candidate END,
          previous_identifier = CASE WHEN col.id IS NOT NULL OR c.candidate <> a.identifier THEN a.identifier ELSE a.previous_identifier END,
          status_id = CASE WHEN tm.mode = 'fold'
                           THEN COALESCE((SELECT s.dst FROM pg_temp._wsmerge_states s WHERE s.src = a.status_id), a.status_id)
                           ELSE a.status_id END,
          assignee_ai_member_id = COALESCE((SELECT t.dst FROM pg_temp._wsmerge_teammates t WHERE t.src = a.assignee_ai_member_id), a.assignee_ai_member_id),
          assignee_contact_id = COALESCE((SELECT ct.dst FROM pg_temp._wsmerge_contacts ct WHERE ct.src = a.assignee_contact_id), a.assignee_contact_id)
      FROM pg_temp._wsmerge_cand c
      LEFT JOIN colliding col ON col.id = c.id
      WHERE a.id = c.id
      RETURNING c.old_identifier, a.identifier AS new_identifier, (col.id IS NOT NULL) AS renumbered
    )
    SELECT count(*),
           count(*) FILTER (WHERE renumbered),
           count(*) FILTER (WHERE NOT renumbered AND old_identifier <> new_identifier),
           COALESCE(jsonb_object_agg(old_identifier, new_identifier) FILTER (WHERE old_identifier <> new_identifier), '{}'::jsonb)
    INTO v_moved, v_renumbered, v_reprefixed, v_map
    FROM moved;

    -- the counter stays ahead of every number now carrying this prefix
    UPDATE public.team t
    SET issue_counter = GREATEST(t.issue_counter, COALESCE((
      SELECT max(substring(a.identifier FROM length(tm.new_prefix) + 2)::bigint) FROM public.actions a
      WHERE a.workspace_id = p_dest AND left(a.identifier, length(tm.new_prefix) + 1) = tm.new_prefix || '-'
        AND substring(a.identifier FROM length(tm.new_prefix) + 2) ~ '^[0-9]{1,9}$'), 0)::int)
    WHERE t.id = tm.dst;

    v_total := v_total + v_moved;
    v_total_renumbered := v_total_renumbered + v_renumbered;
    v_total_reprefixed := v_total_reprefixed + v_reprefixed;
    v_identifier_map := v_identifier_map || v_map;
  END LOOP;

  RETURN jsonb_build_object('actions_moved', v_total, 'identifiers_renumbered', v_total_renumbered,
                            'identifiers_reprefixed', v_total_reprefixed, 'identifier_map', v_identifier_map);
END;
$$;

-- Documents. Rule: everything moves; the destination's canon document keeps
-- the key and the source's becomes an ordinary document named after where it
-- came from; a slug the destination uses gets a suffix; the team follows its
-- map. Revisions, drafts, chunks, checks and opens follow by the generic
-- re-stamp. Public shares stay active (their creator came along).
CREATE OR REPLACE FUNCTION public._wsmerge_documents(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_src_name text; v_demoted int := 0; v_reslugged int := 0; v_moved int := 0;
BEGIN
  SELECT name INTO v_src_name FROM public.workspace WHERE id = p_source;

  UPDATE public.document s
  SET canon_key = NULL, title = s.title || ' (from ' || v_src_name || ')'
  WHERE s.workspace_id = p_source AND s.canon_key IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.document d WHERE d.workspace_id = p_dest AND d.canon_key = s.canon_key
                AND (s.canon_key !~ '^(person|content-brief):' OR d.created_by IS NOT DISTINCT FROM s.created_by));
  GET DIAGNOSTICS v_demoted = ROW_COUNT;

  UPDATE public.document s
  SET slug = s.slug || '-' || left(replace(s.id::text, '-', ''), 8)
  WHERE s.workspace_id = p_source AND s.slug IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.document d WHERE d.workspace_id = p_dest AND d.slug = s.slug);
  GET DIAGNOSTICS v_reslugged = ROW_COUNT;

  UPDATE public.document d
  SET workspace_id = p_dest,
      team_id = COALESCE((SELECT m.dst FROM pg_temp._wsmerge_teams m WHERE m.src = d.team_id), d.team_id)
  WHERE d.workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  RETURN jsonb_build_object('documents_moved', v_moved, 'documents_canon_demoted', v_demoted, 'documents_reslugged', v_reslugged);
END;
$$;

-- Captures and proposals. Rule: everything moves; the team follows its map;
-- a proposal's contact assignee follows the contact map. Children follow by
-- the generic re-stamp.
CREATE OR REPLACE FUNCTION public._wsmerge_captures(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_captures int := 0; v_proposals int := 0;
BEGIN
  UPDATE public.captures c
  SET workspace_id = p_dest,
      team_id = COALESCE((SELECT m.dst FROM pg_temp._wsmerge_teams m WHERE m.src = c.team_id), c.team_id)
  WHERE c.workspace_id = p_source;
  GET DIAGNOSTICS v_captures = ROW_COUNT;

  UPDATE public.proposed_change p
  SET workspace_id = p_dest,
      team_id = COALESCE((SELECT m.dst FROM pg_temp._wsmerge_teams m WHERE m.src = p.team_id), p.team_id),
      assignee_contact_id = COALESCE((SELECT ct.dst FROM pg_temp._wsmerge_contacts ct WHERE ct.src = p.assignee_contact_id), p.assignee_contact_id)
  WHERE p.workspace_id = p_source;
  GET DIAGNOSTICS v_proposals = ROW_COUNT;

  RETURN jsonb_build_object('captures_moved', v_captures, 'proposals_moved', v_proposals);
END;
$$;

-- Contacts. Rule: a source contact whose email exists in the destination
-- folds onto it through merge_contacts (132): the source row crosses over
-- first with its email set aside (so the unique key cannot collide), then the
-- merge machinery re-points participants, interactions, mail links, voice
-- enrollments, comments, shares, enrollments and prospect entries, coalesces
-- fields and writes the contact_merge row that unmerge reads. Everything else
-- re-stamps whole.
CREATE OR REPLACE FUNCTION public._wsmerge_contacts(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; v_folded int := 0; v_moved int := 0;
BEGIN
  FOR r IN SELECT * FROM pg_temp._wsmerge_contacts LOOP
    -- shares and voice trust the destination contact already has
    DELETE FROM public.contact_share s
    WHERE s.contact_id = r.src
      AND EXISTS (SELECT 1 FROM public.contact_share d WHERE d.contact_id = r.dst
                  AND d.shared_with_member_id IS NOT DISTINCT FROM s.shared_with_member_id
                  AND d.shared_with_team_id IS NOT DISTINCT FROM s.shared_with_team_id);
    -- (PROD's voice_contact_trust has no model column: the destination's trust stands)
    DELETE FROM public.voice_contact_trust v
    WHERE v.contact_id = r.src AND EXISTS (SELECT 1 FROM public.voice_contact_trust d WHERE d.contact_id = r.dst);
    UPDATE public.voice_contact_trust SET contact_id = r.dst, workspace_id = p_dest WHERE contact_id = r.src;

    IF to_regclass('public.deal_contact') IS NOT NULL THEN
      EXECUTE 'INSERT INTO public.deal_contact (deal_id, contact_id, role, created_at)
               SELECT deal_id, $2, role, created_at FROM public.deal_contact WHERE contact_id = $1
               ON CONFLICT DO NOTHING' USING r.src, r.dst;
      EXECUTE 'DELETE FROM public.deal_contact WHERE contact_id = $1' USING r.src;
    END IF;

    UPDATE public.contact
    SET workspace_id = p_dest,
        secondary_emails = (SELECT array_agg(DISTINCT e) FROM unnest(COALESCE(secondary_emails, '{}'::text[]) || ARRAY[email]) e WHERE e IS NOT NULL AND e <> ''),
        email = NULL
    WHERE id = r.src;

    PERFORM public.merge_contacts(r.dst, r.src, 'workspace_merge', NULL,
                                  jsonb_build_array('same email in merged workspaces'), 'workspace_merge');

    UPDATE public.actions SET assignee_contact_id = r.dst WHERE assignee_contact_id = r.src;
    UPDATE public.proposed_change SET assignee_contact_id = r.dst WHERE assignee_contact_id = r.src;
    UPDATE public.contact SET merged_into_contact_id = r.dst WHERE merged_into_contact_id = r.src AND id <> r.src;
    PERFORM public._wsmerge_repoint_entity('contact', r.src, r.dst);
    v_folded := v_folded + 1;
  END LOOP;

  UPDATE public.contact SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  RETURN jsonb_build_object('contacts_folded', v_folded, 'contacts_moved', v_moved);
END;
$$;

-- Companies. Rule: same domain folds (contacts, deals, prospect lists and
-- entries re-point; fields coalesce, the destination's winning); the
-- destination keeps its workspace company and a source one that did not fold
-- arrives as an ordinary company.
CREATE OR REPLACE FUNCTION public._wsmerge_companies(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; v_folded int := 0; v_moved int := 0; v_demoted int := 0;
BEGIN
  FOR r IN SELECT * FROM pg_temp._wsmerge_companies LOOP
    UPDATE public.contact SET company_id = r.dst WHERE company_id = r.src;
    IF to_regclass('public.deal') IS NOT NULL THEN
      EXECUTE 'UPDATE public.deal SET company_id = $2 WHERE company_id = $1' USING r.src, r.dst;
    END IF;
    UPDATE public.prospect_list SET source_company_id = r.dst WHERE source_company_id = r.src;
    UPDATE public.prospect_list_entry SET company_id = r.dst WHERE company_id = r.src;
    PERFORM public._wsmerge_repoint_entity('company', r.src, r.dst);

    UPDATE public.company d
    SET website = COALESCE(d.website, s.website),
        industry = COALESCE(d.industry, s.industry),
        description = COALESCE(d.description, s.description),
        logo_url = COALESCE(d.logo_url, s.logo_url),
        employee_count_range = COALESCE(d.employee_count_range, s.employee_count_range),
        annual_revenue_range = COALESCE(d.annual_revenue_range, s.annual_revenue_range),
        address = COALESCE(d.address, s.address), city = COALESCE(d.city, s.city),
        state = COALESCE(d.state, s.state), country = COALESCE(d.country, s.country),
        phone = COALESCE(d.phone, s.phone), contact_email = COALESCE(d.contact_email, s.contact_email),
        tags = (SELECT array_agg(DISTINCT e) FROM unnest(COALESCE(d.tags, '{}'::text[]) || COALESCE(s.tags, '{}'::text[])) e),
        metadata = COALESCE(s.metadata, '{}'::jsonb) || COALESCE(d.metadata, '{}'::jsonb),
        prospect_list_ids = (SELECT COALESCE(array_agg(DISTINCT e), '{}'::uuid[]) FROM unnest(COALESCE(d.prospect_list_ids, '{}'::uuid[]) || COALESCE(s.prospect_list_ids, '{}'::uuid[])) e),
        enrichment_status = COALESCE(d.enrichment_status, s.enrichment_status),
        enriched_at = GREATEST(d.enriched_at, s.enriched_at),
        updated_at = now()
    FROM public.company s
    WHERE d.id = r.dst AND s.id = r.src;

    DELETE FROM public.company WHERE id = r.src;
    v_folded := v_folded + 1;
  END LOOP;

  UPDATE public.company s SET is_workspace_company = false
  WHERE s.workspace_id = p_source AND s.is_workspace_company
    AND EXISTS (SELECT 1 FROM public.company d WHERE d.workspace_id = p_dest AND d.is_workspace_company);
  GET DIAGNOSTICS v_demoted = ROW_COUNT;

  UPDATE public.company SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  RETURN jsonb_build_object('companies_folded', v_folded, 'companies_moved', v_moved, 'workspace_company_demoted', v_demoted);
END;
$$;

-- Mail and connected accounts. Rule: an account homed in the source is
-- re-homed; its links dedupe; a thread copy the destination already holds
-- folds onto it (links filled, labels unioned, drafts re-pointed) and the
-- rest re-stamp; then every account that touched the source is reconciled,
-- as the account-workspaces route does today.
CREATE OR REPLACE FUNCTION public._wsmerge_mail(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_accounts uuid[]; a uuid; v_rehomed int := 0; v_links_deduped int := 0; v_links_moved int := 0;
        v_copies_folded int := 0; v_copies_moved int := 0; v_reviews_dropped int := 0;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT x.account_id), '{}'::uuid[]) INTO v_accounts
  FROM (SELECT j.account_id FROM public.connected_account_workspace j WHERE j.workspace_id = p_source
        UNION SELECT c.id FROM public.connected_account c WHERE c.workspace_id = p_source) x;

  UPDATE public.connected_account SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_rehomed = ROW_COUNT;

  DELETE FROM public.connected_account_workspace s
  WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.connected_account_workspace d WHERE d.workspace_id = p_dest AND d.account_id = s.account_id);
  GET DIAGNOSTICS v_links_deduped = ROW_COUNT;
  UPDATE public.connected_account_workspace SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_links_moved = ROW_COUNT;

  DROP TABLE IF EXISTS pg_temp._wsmerge_threads;
  CREATE TEMP TABLE _wsmerge_threads ON COMMIT DROP AS
    SELECT s.id AS sid, d.id AS did
    FROM public.email_thread_index s
    JOIN public.email_thread_index d
      ON d.workspace_id = p_dest
     AND COALESCE(d.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND d.provider_thread_id = s.provider_thread_id
    WHERE s.workspace_id = p_source;

  UPDATE public.email_thread_index d
  SET linked_contact_id = COALESCE(d.linked_contact_id, s.linked_contact_id),
      linked_capture_id = COALESCE(d.linked_capture_id, s.linked_capture_id),
      linked_action_id = COALESCE(d.linked_action_id, s.linked_action_id),
      linked_project_id = COALESCE(d.linked_project_id, s.linked_project_id),
      is_starred = COALESCE(d.is_starred, false) OR COALESCE(s.is_starred, false),
      needs_reply = COALESCE(d.needs_reply, s.needs_reply),
      trust = COALESCE(d.trust, s.trust)
  FROM pg_temp._wsmerge_threads t
  JOIN public.email_thread_index s ON s.id = t.sid
  WHERE d.id = t.did;

  INSERT INTO public.email_thread_label (thread_id, label_id, created_at)
  SELECT t.did, l.label_id, l.created_at
  FROM public.email_thread_label l JOIN pg_temp._wsmerge_threads t ON t.sid = l.thread_id
  ON CONFLICT DO NOTHING;
  UPDATE public.email_draft e SET email_thread_id = t.did FROM pg_temp._wsmerge_threads t WHERE e.email_thread_id = t.sid;
  DELETE FROM public.email_thread_index s USING pg_temp._wsmerge_threads t WHERE s.id = t.sid;
  GET DIAGNOSTICS v_copies_folded = ROW_COUNT;

  UPDATE public.email_thread_index SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_copies_moved = ROW_COUNT;

  DELETE FROM public.mail_review_activity s
  WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.mail_review_activity d WHERE d.workspace_id = p_dest AND d.user_id = s.user_id);
  GET DIAGNOSTICS v_reviews_dropped = ROW_COUNT;

  -- sync and sending state follow (unique on the account, so nothing collides)
  UPDATE public.email_sync_state SET workspace_id = p_dest WHERE workspace_id = p_source;
  UPDATE public.crm_sync_state SET workspace_id = p_dest WHERE workspace_id = p_source;
  UPDATE public.task_sync_state SET workspace_id = p_dest WHERE workspace_id = p_source;
  UPDATE public.email_draft SET workspace_id = p_dest WHERE workspace_id = p_source;
  UPDATE public.email_hold SET workspace_id = p_dest WHERE workspace_id = p_source;

  FOREACH a IN ARRAY v_accounts LOOP
    PERFORM public.reconcile_email_thread_copies(a);
  END LOOP;

  RETURN jsonb_build_object('accounts_rehomed', v_rehomed, 'account_links_deduped', v_links_deduped, 'account_links_moved', v_links_moved,
                            'thread_copies_folded', v_copies_folded, 'thread_copies_moved', v_copies_moved,
                            'mail_reviews_dropped', v_reviews_dropped, 'accounts_reconciled', cardinality(v_accounts));
END;
$$;

-- Agents, skills, flows. Rule: a skill whose slug the destination uses gets a
-- suffix; teammates arrive with their team through the map; the source's
-- seeded loop goes and its run history re-points to the destination's; every
-- other loop arrives with its team and bot mapped and its configs rewritten.
CREATE OR REPLACE FUNCTION public._wsmerge_agents_flows(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_recipes_reslugged int := 0; v_recipes int := 0; v_teammates int := 0; v_seeded_dropped int := 0; v_flows int := 0;
BEGIN
  UPDATE public.recipe s
  SET slug = s.slug || '-' || left(replace(s.id::text, '-', ''), 6)
  WHERE s.workspace_id = p_source AND s.slug IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.recipe d WHERE d.workspace_id = p_dest AND d.slug = s.slug);
  GET DIAGNOSTICS v_recipes_reslugged = ROW_COUNT;
  UPDATE public.recipe SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_recipes = ROW_COUNT;

  UPDATE public.ai_team_member a
  SET workspace_id = p_dest,
      team_id = COALESCE((SELECT m.dst FROM pg_temp._wsmerge_teams m WHERE m.src = a.team_id), a.team_id)
  WHERE a.workspace_id = p_source;
  GET DIAGNOSTICS v_teammates = ROW_COUNT;

  UPDATE public.flow_run fr SET flow_id = m.dst FROM pg_temp._wsmerge_flows m WHERE fr.flow_id = m.src;
  UPDATE public.flow_run_state s SET flow_id = m.dst, workspace_id = p_dest FROM pg_temp._wsmerge_flows m WHERE s.flow_id = m.src;
  UPDATE public.agent_run r SET flow_id = m.dst FROM pg_temp._wsmerge_flows m WHERE r.flow_id = m.src;
  UPDATE public.lens_finding l SET flow_id = m.dst FROM pg_temp._wsmerge_flows m WHERE l.flow_id = m.src;
  DELETE FROM public.flow f USING pg_temp._wsmerge_flows m WHERE f.id = m.src;
  GET DIAGNOSTICS v_seeded_dropped = ROW_COUNT;

  UPDATE public.flow f
  SET workspace_id = p_dest,
      team_id = COALESCE((SELECT m.dst FROM pg_temp._wsmerge_teams m WHERE m.src = f.team_id), f.team_id),
      ai_team_member_id = COALESCE((SELECT t.dst FROM pg_temp._wsmerge_teammates t WHERE t.src = f.ai_team_member_id), f.ai_team_member_id),
      trigger_config = public._wsmerge_rewrite_json(f.trigger_config),
      actions = public._wsmerge_rewrite_json(f.actions)
  WHERE f.workspace_id = p_source;
  GET DIAGNOSTICS v_flows = ROW_COUNT;

  RETURN jsonb_build_object('recipes_moved', v_recipes, 'recipes_reslugged', v_recipes_reslugged, 'teammates_moved', v_teammates,
                            'seeded_flows_dropped', v_seeded_dropped, 'flows_moved', v_flows);
END;
$$;

-- Knowledge. Rule: every claim, its evidence and chunks move (no evidence
-- partition: nothing stays behind); an edge or embedding the destination
-- already has is the same knowledge and drops; the source's workspace brief
-- goes and the destination's recompiles; packages arrive with a free slug,
-- their rules rewritten and their shares deduped; profile facts keep their
-- origin.
CREATE OR REPLACE FUNCTION public._wsmerge_knowledge(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_links_deduped int := 0; v_links int := 0; v_anchors_deduped int := 0; v_briefs_dropped int := 0; v_packages int := 0; v_packages_reslugged int := 0;
BEGIN
  UPDATE public.claim SET workspace_id = p_dest WHERE workspace_id = p_source;
  UPDATE public.claim_source SET workspace_id = p_dest WHERE workspace_id = p_source;
  UPDATE public.claim_chunks SET workspace_id = p_dest WHERE workspace_id = p_source;

  DELETE FROM public.entity_link s
  WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.entity_link d WHERE d.workspace_id = p_dest AND d.source_type = s.source_type AND d.source_id = s.source_id
                AND d.target_type = s.target_type AND d.target_id = s.target_id AND d.relation = s.relation);
  GET DIAGNOSTICS v_links_deduped = ROW_COUNT;
  UPDATE public.entity_link SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_links = ROW_COUNT;

  DELETE FROM public.anchor_embedding s
  WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.anchor_embedding d WHERE d.workspace_id = p_dest AND d.entity_type = s.entity_type AND d.entity_id = s.entity_id);
  GET DIAGNOSTICS v_anchors_deduped = ROW_COUNT;
  UPDATE public.anchor_embedding SET workspace_id = p_dest WHERE workspace_id = p_source;

  DELETE FROM public.knowledge_brief s
  WHERE s.workspace_id = p_source
    AND (s.scope_type = 'workspace'
         OR EXISTS (SELECT 1 FROM public.knowledge_brief d WHERE d.workspace_id = p_dest AND d.scope_type = s.scope_type AND d.scope_id IS NOT DISTINCT FROM s.scope_id));
  GET DIAGNOSTICS v_briefs_dropped = ROW_COUNT;
  UPDATE public.knowledge_brief SET source_fingerprint = NULL WHERE workspace_id = p_dest AND scope_type = 'workspace';
  UPDATE public.knowledge_brief SET workspace_id = p_dest WHERE workspace_id = p_source;

  UPDATE public.knowledge_package s
  SET slug = s.slug || '-' || left(replace(s.id::text, '-', ''), 6)
  WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.knowledge_package d WHERE d.workspace_id = p_dest AND d.slug = s.slug);
  GET DIAGNOSTICS v_packages_reslugged = ROW_COUNT;
  UPDATE public.knowledge_package k
  SET workspace_id = p_dest,
      team_id = COALESCE((SELECT m.dst FROM pg_temp._wsmerge_teams m WHERE m.src = k.team_id), k.team_id),
      rules = public._wsmerge_rewrite_json(k.rules)
  WHERE k.workspace_id = p_source;
  GET DIAGNOSTICS v_packages = ROW_COUNT;

  UPDATE public.profile_fact SET source_workspace_id = p_dest WHERE source_workspace_id = p_source;

  RETURN jsonb_build_object('entity_links_moved', v_links, 'entity_links_deduped', v_links_deduped, 'anchor_embeddings_deduped', v_anchors_deduped,
                            'briefs_dropped', v_briefs_dropped, 'packages_moved', v_packages, 'packages_reslugged', v_packages_reslugged);
END;
$$;

-- Chat. Rule: a person's source home thread becomes an ordinary conversation
-- when they already have one in the destination; every moved conversation
-- drops its eve session (primed for the source) and re-primes from its
-- checkpoint in the destination.
CREATE OR REPLACE FUNCTION public._wsmerge_chat(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_src_name text; v_home_demoted int := 0; v_moved int := 0;
BEGIN
  SELECT name INTO v_src_name FROM public.workspace WHERE id = p_source;

  UPDATE public.chat_conversations c
  SET is_home = NULL, title = COALESCE(NULLIF(c.title, ''), 'Home') || ' · ' || v_src_name
  WHERE c.workspace_id = p_source AND c.is_home
    AND EXISTS (SELECT 1 FROM public.chat_conversations d WHERE d.workspace_id = p_dest AND d.is_home AND d.user_id = c.user_id);
  GET DIAGNOSTICS v_home_demoted = ROW_COUNT;

  UPDATE public.chat_conversations SET workspace_id = p_dest, eve_session_id = NULL WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  RETURN jsonb_build_object('conversations_moved', v_moved, 'home_threads_demoted', v_home_demoted);
END;
$$;

-- Saved views. Rule: the team follows its map; a slug the destination uses
-- gets a suffix (the slug trigger only regenerates on a name change); the
-- id-bearing JSON columns are rewritten through the maps.
CREATE OR REPLACE FUNCTION public._wsmerge_views(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_moved int := 0; v_reslugged int := 0;
BEGIN
  SELECT count(*) INTO v_reslugged FROM public.view s
  WHERE s.workspace_id = p_source AND s.slug IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.view d WHERE d.workspace_id = p_dest AND d.slug = s.slug);

  UPDATE public.view v
  SET workspace_id = p_dest,
      team_id = COALESCE((SELECT m.dst FROM pg_temp._wsmerge_teams m WHERE m.src = v.team_id), v.team_id),
      slug = CASE WHEN v.slug IS NOT NULL AND EXISTS (SELECT 1 FROM public.view d WHERE d.workspace_id = p_dest AND d.slug = v.slug)
                  THEN v.slug || '-' || left(replace(v.id::text, '-', ''), 6) ELSE v.slug END,
      filters = public._wsmerge_rewrite_json(v.filters),
      grouping = public._wsmerge_rewrite_json(v.grouping),
      sub_grouping = public._wsmerge_rewrite_json(v.sub_grouping),
      ordering = public._wsmerge_rewrite_json(v.ordering),
      metadata = public._wsmerge_rewrite_json(v.metadata)
  WHERE v.workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  RETURN jsonb_build_object('views_moved', v_moved, 'views_reslugged', v_reslugged);
END;
$$;

-- Per-person and per-workspace singletons. Rule: the destination's wins; a
-- source duplicate drops. Active enrollments: one per contact or email, the
-- destination's stands. Prospect lists by name are renamed.
CREATE OR REPLACE FUNCTION public._wsmerge_singletons(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_src_name text; v_out jsonb := '{}'::jsonb; n int;
BEGIN
  SELECT name INTO v_src_name FROM public.workspace WHERE id = p_source;

  DELETE FROM public.meeting_goal s WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.meeting_goal d WHERE d.workspace_id = p_dest AND d.user_id = s.user_id
                AND d.calendar_event_id = s.calendar_event_id AND d.starts_at = s.starts_at);
  GET DIAGNOSTICS n = ROW_COUNT; v_out := v_out || jsonb_build_object('meeting_goals_dropped', n);

  DELETE FROM public.area_memory_learning_run s WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.area_memory_learning_run d WHERE d.workspace_id = p_dest AND d.user_id = s.user_id AND d.area = s.area AND d.run_date = s.run_date);
  GET DIAGNOSTICS n = ROW_COUNT; v_out := v_out || jsonb_build_object('learning_runs_dropped', n);

  DELETE FROM public.agent_log s WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.agent_log d WHERE d.workspace_id = p_dest AND d.user_id = s.user_id AND d.dedupe_key = s.dedupe_key);
  GET DIAGNOSTICS n = ROW_COUNT; v_out := v_out || jsonb_build_object('agent_log_dropped', n);

  DELETE FROM public.agent_event s WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.agent_event d WHERE d.workspace_id = p_dest AND d.user_id = s.user_id AND d.dedupe_key = s.dedupe_key);
  GET DIAGNOSTICS n = ROW_COUNT; v_out := v_out || jsonb_build_object('agent_events_dropped', n);

  DELETE FROM public.eval_candidate s WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.eval_candidate d WHERE d.workspace_id = p_dest AND d.user_id = s.user_id AND d.dedupe_key = s.dedupe_key);
  GET DIAGNOSTICS n = ROW_COUNT; v_out := v_out || jsonb_build_object('eval_candidates_dropped', n);

  DELETE FROM public.reminder s WHERE s.workspace_id = p_source AND s.delivered_at IS NULL
    AND EXISTS (SELECT 1 FROM public.reminder d WHERE d.workspace_id = p_dest AND d.delivered_at IS NULL
                AND d.user_id = s.user_id AND d.entity_type = s.entity_type AND d.entity_id = s.entity_id);
  GET DIAGNOSTICS n = ROW_COUNT; v_out := v_out || jsonb_build_object('reminders_dropped', n);

  DELETE FROM public.outreach_suppression s WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.outreach_suppression d WHERE d.workspace_id = p_dest AND lower(d.email) = lower(s.email));
  GET DIAGNOSTICS n = ROW_COUNT; v_out := v_out || jsonb_build_object('suppressions_deduped', n);

  UPDATE public.sequence_enrollment s
  SET status = 'exited', exit_reason = 'removed', next_send_at = NULL
  WHERE s.workspace_id = p_source AND s.status = 'active'
    AND EXISTS (SELECT 1 FROM public.sequence_enrollment d WHERE d.workspace_id = p_dest AND d.status = 'active'
                AND (d.contact_id = s.contact_id OR lower(d.contact_email) = lower(s.contact_email)));
  GET DIAGNOSTICS n = ROW_COUNT; v_out := v_out || jsonb_build_object('sequence_enrollments_exited', n);

  UPDATE public.prospect_list s SET name = s.name || ' (' || v_src_name || ')'
  WHERE s.workspace_id = p_source
    AND EXISTS (SELECT 1 FROM public.prospect_list d WHERE d.workspace_id = p_dest AND lower(d.name) = lower(s.name));
  GET DIAGNOSTICS n = ROW_COUNT; v_out := v_out || jsonb_build_object('prospect_lists_renamed', n);

  RETURN v_out;
END;
$$;

-- Teams, second half (folded teams). Rule: cycles re-point and renumber after
-- the destination's (a second active sprint becomes upcoming); team
-- membership and team shares dedupe; deals follow with their status mapped;
-- then the source team goes, taking its states with it — every action was
-- re-pointed, so the NO ACTION foreign key on status lets it.
CREATE OR REPLACE FUNCTION public._wsmerge_teams_finish(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE tm record; v_base int; v_cycles int := 0; v_cycles_demoted int := 0; v_deleted int := 0; n int;
BEGIN
  FOR tm IN SELECT * FROM pg_temp._wsmerge_teams WHERE mode = 'fold' ORDER BY ord LOOP
    SELECT COALESCE(max(number), 0) INTO v_base FROM public.cycle WHERE team_id = tm.dst;

    UPDATE public.cycle c
    SET team_id = tm.dst,
        number = v_base + x.rn,
        status = CASE WHEN c.status = 'active' AND EXISTS (SELECT 1 FROM public.cycle d WHERE d.team_id = tm.dst AND d.status = 'active')
                      THEN 'upcoming'::public.cycle_status ELSE c.status END
    FROM (SELECT id, row_number() OVER (ORDER BY number, created_at, id) AS rn FROM public.cycle WHERE team_id = tm.src) x
    WHERE c.id = x.id;
    GET DIAGNOSTICS n = ROW_COUNT; v_cycles := v_cycles + n;

    UPDATE public.team_member t SET team_id = tm.dst
    WHERE t.team_id = tm.src AND NOT EXISTS (SELECT 1 FROM public.team_member d WHERE d.team_id = tm.dst AND d.member_id = t.member_id);
    DELETE FROM public.team_member WHERE team_id = tm.src;

    UPDATE public.contact_share s SET shared_with_team_id = tm.dst
    WHERE s.shared_with_team_id = tm.src AND NOT EXISTS (SELECT 1 FROM public.contact_share d WHERE d.contact_id = s.contact_id AND d.shared_with_team_id = tm.dst);
    DELETE FROM public.contact_share WHERE shared_with_team_id = tm.src;

    UPDATE public.knowledge_package_share s SET shared_with_team_id = tm.dst
    WHERE s.shared_with_team_id = tm.src AND NOT EXISTS (SELECT 1 FROM public.knowledge_package_share d WHERE d.package_id = s.package_id AND d.shared_with_team_id = tm.dst);
    DELETE FROM public.knowledge_package_share WHERE shared_with_team_id = tm.src;

    IF to_regclass('public.deal') IS NOT NULL THEN
      EXECUTE 'UPDATE public.deal d
               SET team_id = $2,
                   status_id = COALESCE((SELECT s.dst FROM pg_temp._wsmerge_states s WHERE s.src = d.status_id), d.status_id)
               WHERE d.team_id = $1' USING tm.src, tm.dst;
    END IF;

    DELETE FROM public.team WHERE id = tm.src;
    v_deleted := v_deleted + 1;
  END LOOP;

  RETURN jsonb_build_object('folded_teams_deleted', v_deleted, 'cycles_refiled', v_cycles);
END;
$$;

-- Everything else with a workspace_id column re-stamps, by catalogue, so a
-- table added later is carried too. A uniqueness this migration did not
-- foresee raises here (unique_violation names the table) and rolls the merge
-- back: the safe failure.
CREATE OR REPLACE FUNCTION public._wsmerge_generic_restamp(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; n int; v_out jsonb := '{}'::jsonb;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
      AND c.table_name NOT IN ('workspace', 'workspace_move_log', 'workspace_merge')
    ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('UPDATE public.%I SET workspace_id = $1 WHERE workspace_id = $2', r.table_name) USING p_dest, p_source;
      GET DIAGNOSTICS n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'merge cannot re-stamp %: a uniqueness this merge does not resolve (%)', r.table_name, SQLERRM
        USING ERRCODE = 'P0008';
    END;
    IF n > 0 THEN
      v_out := v_out || jsonb_build_object(r.table_name, n);
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;

-- Pointers that would otherwise go NULL (and fall back to the person's
-- oldest workspace) or dangle.
CREATE OR REPLACE FUNCTION public._wsmerge_pointers(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_devices int := 0; v_mcp int := 0;
BEGIN
  UPDATE public.device_token SET active_workspace_id = p_dest WHERE active_workspace_id = p_source;
  GET DIAGNOSTICS v_devices = ROW_COUNT;
  UPDATE public.mcp_oauth_token SET active_workspace_id = p_dest WHERE active_workspace_id = p_source;
  GET DIAGNOSTICS v_mcp = ROW_COUNT;
  UPDATE public.mcp_audit_log SET target_workspace_id = p_dest WHERE target_workspace_id = p_source;
  UPDATE public.user_onboarding SET demo_workspace_id = p_dest WHERE demo_workspace_id = p_source;
  RETURN jsonb_build_object('device_tokens_repointed', v_devices, 'mcp_tokens_repointed', v_mcp);
END;
$$;

-- The last word before the source row goes: no table still holds a source
-- row, and the destination passes the sweep.
CREATE OR REPLACE FUNCTION public._wsmerge_assert(p_source uuid, p_dest uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; n bigint; v_left text; v_drift text;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
      AND c.table_name NOT IN ('workspace', 'workspace_move_log', 'workspace_merge')
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE workspace_id = $1', r.table_name) INTO n USING p_source;
    IF n > 0 THEN
      v_left := concat_ws(', ', v_left, r.table_name || '=' || n);
    END IF;
  END LOOP;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'merge left rows under the source workspace: %', v_left USING ERRCODE = 'P0008';
  END IF;
  IF EXISTS (SELECT 1 FROM public.team WHERE workspace_id = p_source)
     OR EXISTS (SELECT 1 FROM public.member WHERE workspace_id = p_source) THEN
    RAISE EXCEPTION 'merge left a team or member under the source workspace' USING ERRCODE = 'P0008';
  END IF;

  SELECT string_agg(check_name || '=' || violations, ', ') INTO v_drift FROM public.workspace_integrity_sweep(p_dest);
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'destination fails the integrity sweep after the merge: %', v_drift USING ERRCODE = 'P0008';
  END IF;
END;
$$;

-- ============================================================
-- 8. merge_workspace — the merge, in one transaction
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_workspace(
  p_source uuid,
  p_destination uuid,
  p_actor uuid,
  p_plan jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_t0 timestamptz := clock_timestamp();
  v_src public.workspace%ROWTYPE;
  v_dst public.workspace%ROWTYPE;
  v_plan jsonb; v_busy jsonb; v_drift text; v_before jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_ms int;
BEGIN
  -- the merge setting: transaction-local, read by the guard exemptions
  PERFORM set_config('dial8.workspace_merge', v_id::text, true);

  PERFORM public._wsmerge_gate(p_source, p_destination, p_actor);

  -- both workspace rows locked, lowest id first (serialises with chat
  -- admission's FOR NO KEY UPDATE and with a concurrent merge either way)
  IF p_source < p_destination THEN
    SELECT * INTO v_src FROM public.workspace WHERE id = p_source FOR UPDATE;
    SELECT * INTO v_dst FROM public.workspace WHERE id = p_destination FOR UPDATE;
  ELSE
    SELECT * INTO v_dst FROM public.workspace WHERE id = p_destination FOR UPDATE;
    SELECT * INTO v_src FROM public.workspace WHERE id = p_source FOR UPDATE;
  END IF;
  IF v_src.id IS NULL OR v_dst.id IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;

  v_plan := public._wsmerge_plan(p_source, p_destination, COALESCE(p_plan, '{}'::jsonb));

  -- refusals: a busy source, drift on either side
  v_busy := public._wsmerge_busy(p_source);
  IF jsonb_array_length(v_busy->'live_captures') > 0
     OR (v_busy->>'agent_runs')::int > 0 OR (v_busy->>'flow_runs')::int > 0 OR (v_busy->>'tracked_jobs')::int > 0 THEN
    RAISE EXCEPTION 'the source workspace is busy: %', v_busy::text USING ERRCODE = 'P0007';
  END IF;
  SELECT string_agg(check_name || '=' || violations, ', ') INTO v_drift FROM public.workspace_integrity_sweep(p_source);
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'the source workspace fails the integrity sweep: %', v_drift USING ERRCODE = 'P0009';
  END IF;
  SELECT string_agg(check_name || '=' || violations, ', ') INTO v_drift FROM public.workspace_integrity_sweep(p_destination);
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'the destination workspace fails the integrity sweep: %', v_drift USING ERRCODE = 'P0009';
  END IF;

  v_before := public._wsmerge_counts(p_source);
  PERFORM public._wsmerge_build_maps(p_source, p_destination, v_plan);

  v_counts := v_counts || public._wsmerge_members(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_system_teammates(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_teams_begin(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_labels(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_integrations(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_default_projects(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_actions(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_documents(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_captures(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_contacts(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_companies(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_mail(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_agents_flows(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_knowledge(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_chat(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_views(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_singletons(p_source, p_destination);
  v_counts := v_counts || public._wsmerge_teams_finish(p_source, p_destination);
  v_counts := v_counts || jsonb_build_object('restamped', public._wsmerge_generic_restamp(p_source, p_destination));
  v_counts := v_counts || public._wsmerge_pointers(p_source, p_destination);

  PERFORM public._wsmerge_assert(p_source, p_destination);

  v_ms := (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int;
  INSERT INTO public.workspace_merge (
    id, source_workspace_id, source_name, source_slug, source_settings, source_created_at,
    destination_workspace_id, actor_user_id, plan, counts, snapshot, started_at, finished_at, duration_ms
  ) VALUES (
    v_id, v_src.id, v_src.name, v_src.slug, COALESCE(v_src.settings, '{}'::jsonb), v_src.created_at,
    p_destination, p_actor, v_plan - 'snapshot', v_counts || jsonb_build_object('rows_before', v_before),
    v_plan->'snapshot', v_t0, clock_timestamp(), v_ms
  );

  -- the empty shell; nothing cascades from it any more
  DELETE FROM public.workspace WHERE id = p_source;

  RETURN jsonb_build_object(
    'merge_id', v_id,
    'source', jsonb_build_object('id', v_src.id, 'name', v_src.name, 'slug', v_src.slug),
    'destination', jsonb_build_object('id', v_dst.id, 'name', v_dst.name, 'slug', v_dst.slug),
    'counts', v_counts,
    'rows_before', v_before,
    'duration_ms', v_ms
  );
END;
$$;

-- ============================================================
-- 9. Snapshot export, paged. The route stores one object per table and page
--    before calling merge_workspace. Vectors, search vectors and credential
--    material are left out (re-derivable or re-issuable, never data).
-- ============================================================

CREATE OR REPLACE FUNCTION public._wsmerge_export_tables()
RETURNS TABLE (table_name text, predicate text)
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$
  SELECT c.table_name::text, 'workspace_id = $1'
  FROM information_schema.columns c
  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
    AND c.table_name NOT IN ('workspace_merge')
  UNION ALL SELECT 'workspace', 'id = $1'
  UNION ALL SELECT 'workspace_move_log', 'source_workspace_id = $1 OR destination_workspace_id = $1'
  UNION ALL SELECT v.t, v.p FROM (VALUES
    ('workflow_state', 'team_id IN (SELECT id FROM public.team WHERE workspace_id = $1)'),
    ('cycle', 'team_id IN (SELECT id FROM public.team WHERE workspace_id = $1)'),
    ('team_member', 'team_id IN (SELECT id FROM public.team WHERE workspace_id = $1)'),
    ('decision', 'capture_id IN (SELECT id FROM public.captures WHERE workspace_id = $1)'),
    ('capture_participant', 'capture_id IN (SELECT id FROM public.captures WHERE workspace_id = $1)'),
    ('action_assignee', 'action_id IN (SELECT id FROM public.actions WHERE workspace_id = $1)'),
    ('action_relation', 'action_id IN (SELECT id FROM public.actions WHERE workspace_id = $1)'),
    ('action_document', 'action_id IN (SELECT id FROM public.actions WHERE workspace_id = $1)'),
    ('milestone', 'project_id IN (SELECT id FROM public.projects WHERE workspace_id = $1)'),
    ('flow_run', 'flow_id IN (SELECT id FROM public.flow WHERE workspace_id = $1)'),
    ('share_comment', 'share_id IN (SELECT id FROM public.share WHERE workspace_id = $1)'),
    ('view_favorite', 'view_id IN (SELECT id FROM public.view WHERE workspace_id = $1)'),
    ('ai_team_member_skill', 'ai_team_member_id IN (SELECT id FROM public.ai_team_member WHERE workspace_id = $1)'),
    ('action_label', 'label_id IN (SELECT id FROM public.label WHERE workspace_id = $1)'),
    ('capture_label', 'label_id IN (SELECT id FROM public.label WHERE workspace_id = $1)'),
    ('project_label', 'label_id IN (SELECT id FROM public.label WHERE workspace_id = $1)'),
    ('initiative_label', 'label_id IN (SELECT id FROM public.label WHERE workspace_id = $1)'),
    ('email_thread_label', 'label_id IN (SELECT id FROM public.label WHERE workspace_id = $1)'),
    ('deal_contact', 'deal_id IN (SELECT id FROM public.deal WHERE workspace_id = $1)'),
    ('comment', 'EXISTS (SELECT 1 FROM public.actions a WHERE a.id = x.commentable_id AND a.workspace_id = $1)'
             || ' OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id = x.commentable_id AND a.workspace_id = $1)'
             || ' OR EXISTS (SELECT 1 FROM public.document a WHERE a.id = x.commentable_id AND a.workspace_id = $1)'
             || ' OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id = x.commentable_id AND a.workspace_id = $1)'
             || ' OR EXISTS (SELECT 1 FROM public.contact a WHERE a.id = x.commentable_id AND a.workspace_id = $1)'),
    ('email_account_preference', 'account_id IN (SELECT id FROM public.connected_account WHERE workspace_id = $1)'),
    ('calendar_account_preference', 'account_id IN (SELECT id FROM public.connected_account WHERE workspace_id = $1)'),
    ('calendar_sub_preference', 'account_id IN (SELECT id FROM public.connected_account WHERE workspace_id = $1)')
  ) AS v(t, p);
$$;

CREATE OR REPLACE FUNCTION public.export_workspace_manifest(p_workspace uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; n bigint; v_out jsonb := '[]'::jsonb;
BEGIN
  FOR r IN SELECT * FROM public._wsmerge_export_tables() ORDER BY table_name LOOP
    IF to_regclass('public.' || quote_ident(r.table_name)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I x WHERE %s', r.table_name, r.predicate) INTO n USING p_workspace;
    IF n > 0 THEN
      v_out := v_out || jsonb_build_object('table', r.table_name, 'rows', n);
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.export_workspace_rows(p_workspace uuid, p_table text, p_offset int DEFAULT 0, p_limit int DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_pred text; v_cols text; v_order text; v_out jsonb;
BEGIN
  SELECT predicate INTO v_pred FROM public._wsmerge_export_tables() WHERE table_name = p_table;
  IF v_pred IS NULL OR to_regclass('public.' || quote_ident(p_table)) IS NULL THEN
    RAISE EXCEPTION 'table % is not exported', p_table USING ERRCODE = '22023';
  END IF;
  IF p_offset < 0 OR p_limit < 1 OR p_limit > 20000 THEN
    RAISE EXCEPTION 'offset must be >= 0 and limit between 1 and 20000' USING ERRCODE = '22023';
  END IF;

  SELECT string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = p_table
    AND c.udt_name NOT IN ('vector', 'halfvec', 'tsvector')
    AND NOT (c.table_name = 'cloud_environment' AND c.column_name = 'env_vars')
    AND NOT (c.table_name = 'connected_mcp_server' AND c.column_name IN ('access_token_encrypted', 'refresh_token_encrypted'))
    AND NOT (c.table_name = 'task_sync_state' AND c.column_name = 'webhook_secret');

  SELECT string_agg(format('%I', a.attname), ', ' ORDER BY k.ord) INTO v_order
  FROM pg_index i
  CROSS JOIN LATERAL unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
  WHERE i.indrelid = ('public.' || quote_ident(p_table))::regclass AND i.indisprimary;

  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(to_jsonb(r)), ''[]''::jsonb) FROM (SELECT %s FROM public.%I x WHERE %s ORDER BY %s OFFSET %s LIMIT %s) r',
    v_cols, p_table, v_pred, COALESCE(v_order, 'x.ctid'), p_offset, p_limit)
  INTO v_out USING p_workspace;
  RETURN v_out;
END;
$$;

-- ============================================================
-- 10. Grants. The helpers are reachable only through the entry points; the
--     entry points, the sweep and the export belong to the server
--     (service_role). _wsmerge_active() is read by triggers under any role.
-- ============================================================

DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND (p.proname LIKE '\_wsmerge\_%'
           OR p.proname IN ('merge_workspace', 'merge_workspace_preflight', 'workspace_integrity_sweep',
                            'export_workspace_manifest', 'export_workspace_rows'))
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public._wsmerge_active() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_workspace(uuid, uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_workspace_preflight(uuid, uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.workspace_integrity_sweep(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.export_workspace_manifest(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.export_workspace_rows(uuid, text, int, int) TO service_role;

NOTIFY pgrst, 'reload schema';
