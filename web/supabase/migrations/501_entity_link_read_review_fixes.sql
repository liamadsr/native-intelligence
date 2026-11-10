-- ============================================================
-- 501: graph edges (500), after review.
-- ============================================================
-- 1. claim_neighborhood is no longer callable by a signed-in user. It is
--    SECURITY DEFINER and walks entity_link itself, so a direct call from the
--    REST API went around 500: a plain member got a hidden private contact's
--    edge and its full_name, company and attachment names, and the ids of
--    calendar events, team chat and decisions. Its one caller is
--    get_context_bundle (src/lib/ai/tools/claims.ts), which runs on the
--    service role and fences the bundle itself (dropHiddenFromBundle, the
--    label fences). So: service role only, as 193 did for the move helpers.
--
-- 2. A company end costs one query, not one call per edge. 500 asked
--    entity_visible_to per company end, and company_visible_to walks the
--    company's contacts: 44 ms warm per edge for a non-admin on a company
--    with 1,942 contacts, enough for the knowledge map's paged reads to meet
--    the 8 s statement timeout (on DEV, a 10,757-edge read with 500 company
--    ends did: 500 cancelled it; 501 answers in 335 ms).
--    private.companies_hidden_from_me() is the set-based form, like 341's
--    claims_hidden_from_me: an uncorrelated IN, so a hashed subplan built
--    once per statement and per end, and only when an edge has a company
--    end at that side. Two ways of building each set only once per
--    statement were measured on DEV and dropped: one set of claim and
--    company keys together (every claim edge then paid for the companies; a
--    read by target went from 4 to 9 ms), and probing both ends through a
--    VALUES pair (the planner turned the IN into a per-row join; a 378-edge
--    read went from 24 ms to 1.3 s). So a statement still builds the claim
--    set at most twice, as 500 did.
--    The company arm restates company_visible_to (235/493) for auth.uid():
--    an owner or admin sees every company; anyone else one a grant reaches,
--    or one with a live (unmerged) contact they can see by
--    contact_visible_to's rules (058/234/493). Change one, change the other.
--
-- 3. Writing an edge asks the read rule too. 500 kept the write policies at
--    "a member of the workspace", so a member who knew the id of a private
--    record could attach edges to it. INSERT's WITH CHECK is now the SELECT
--    rule: you may write only an edge you could read. The app's writers
--    (mention sync, document links, link_entities) already fence their
--    targets for the writer, so a legitimate write passes.
--
-- 4. _claim_sync_project_ids (276) was executable by anon and authenticated.
--    Its only caller is the entity_link trigger function, itself SECURITY
--    DEFINER, so revoking the direct grant changes nothing it does.
--
-- After 500. Idempotent (create or replace, drop policy if exists, revoke
-- and grant restated). No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── 1. claim_neighborhood: service role only ─────────────────────────────────
revoke all on function public.claim_neighborhood(text, text, text, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_neighborhood(text, text, text, integer, integer, uuid) to service_role;

-- ── 4. _claim_sync_project_ids: the trigger's alone ──────────────────────────
revoke all on function public._claim_sync_project_ids(uuid) from public, anon, authenticated;
grant execute on function public._claim_sync_project_ids(uuid) to service_role;

-- ── 2. The companies hidden from the caller, in one set ──────────────────────
create or replace function private.companies_hidden_from_me()
returns setof uuid
language sql
stable
security definer
rows 100
set search_path = public, pg_temp
as $$
  select co.id
    from public.company co
    join public.member me on me.workspace_id = co.workspace_id and me.user_id = auth.uid()
   where coalesce(me.role, '') not in ('owner', 'admin')
     and not (co.id = any ((select public.my_entity_grant_ids('company'))::uuid[]))
     and not exists (
       select 1
         from public.contact ct
        where ct.company_id = co.id
          and ct.merged_into_contact_id is null
          and (
            ct.visibility = 'workspace'
            or (ct.created_by_member_id is not null and ct.created_by_member_id = me.id)
            or (ct.visibility = 'team' and ct.created_by_member_id is not null and exists (
                  select 1
                    from public.team_member tm1
                    join public.team_member tm2 on tm2.team_id = tm1.team_id
                   where tm1.member_id = me.id and tm2.member_id = ct.created_by_member_id))
            or exists (
                  select 1 from public.contact_share cs
                   where cs.contact_id = ct.id and cs.shared_with_member_id = me.id)
            or exists (
                  select 1
                    from public.contact_share cs
                    join public.team_member tm on tm.team_id = cs.shared_with_team_id
                   where cs.contact_id = ct.id and tm.member_id = me.id)
            or ct.id = any ((select public.my_entity_grant_ids('contact'))::uuid[])
          )
     );
$$;

revoke all on function private.companies_hidden_from_me() from public, anon;
grant execute on function private.companies_hidden_from_me() to authenticated, service_role;

-- ── 2 + 3. The policies ──────────────────────────────────────────────────────
-- An edge is readable (and writable) when the caller is a member of its
-- workspace, neither end is a claim or company in its hidden set, and every
-- end of another fenced kind passes entity_visible_to (500).
drop policy if exists entity_link_select on public.entity_link;
create policy entity_link_select on public.entity_link
  for select
  using (
    public.is_workspace_member(workspace_id)
    and (source_type <> 'claim' or not (source_id in (select private.claims_hidden_from_me())))
    and (target_type <> 'claim' or not (target_id in (select private.claims_hidden_from_me())))
    and (source_type <> 'company' or not (source_id in (select private.companies_hidden_from_me())))
    and (target_type <> 'company' or not (target_id in (select private.companies_hidden_from_me())))
    and (source_type <> all ('{document,capture,contact,attachment,email,conversation,calendar_event,team_chat_channel,team_chat_message,decision}'::text[])
         or public.entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> all ('{document,capture,contact,attachment,email,conversation,calendar_event,team_chat_channel,team_chat_message,decision}'::text[])
         or public.entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_insert on public.entity_link;
create policy entity_link_insert on public.entity_link
  for insert
  with check (
    public.is_workspace_member(workspace_id)
    and (source_type <> 'claim' or not (source_id in (select private.claims_hidden_from_me())))
    and (target_type <> 'claim' or not (target_id in (select private.claims_hidden_from_me())))
    and (source_type <> 'company' or not (source_id in (select private.companies_hidden_from_me())))
    and (target_type <> 'company' or not (target_id in (select private.companies_hidden_from_me())))
    and (source_type <> all ('{document,capture,contact,attachment,email,conversation,calendar_event,team_chat_channel,team_chat_message,decision}'::text[])
         or public.entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> all ('{document,capture,contact,attachment,email,conversation,calendar_event,team_chat_channel,team_chat_message,decision}'::text[])
         or public.entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

notify pgrst, 'reload schema';
