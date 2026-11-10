-- ============================================================
-- 503: one name for mail.
-- ============================================================
-- The same kind had two names. The UI, its lists and labels, the activity
-- tab, the work ledger and the CRM's interactions called a thread's index
-- row `email_thread`; the entity registry, and so the graph (entity_link,
-- knowledge_package_item) and the edge rule of 500, called it `email`. Now
-- it is `email_thread` everywhere.
--
-- Why this name: it is the one already stored almost everywhere, so it is
-- the one that moves the fewest rows.
--   Already `email_thread`, untouched: view.entity_type (the view_entity_type
--   enum has the label), label.scope, work_touch.entity_type,
--   contact_interaction.reference_type (and its CHECK), agent_event.ref_type,
--   attention_item.entity_type.
--   Was `email`, rewritten here: entity_link.source_type / target_type,
--   knowledge_package_item.entity_type, and for safety the polymorphic kind
--   columns a stray `email` could sit in (entity_activity, anchor_embedding,
--   work_touch, attention_item). On DEV every one of these held zero
--   `email` rows (342 purged mail from the graph on 2026-10-15); the rewrite
--   is for whatever an agent linked since.
-- It is also the true name: the row is a thread's index row
-- (email_thread_index), and the agent's mail tools already say thread
-- (update_email_thread).
--
-- What keeps the old name, and why:
--   claim_source.source_type 'email': a retired value naming the dropped
--   email_message table (344), never this kind. Mail is never cited (341),
--   so the CHECK keeps 'email' as a tombstone that the mail fences
--   (claim_visible_to, hybrid_search, claim_sources_hidden_from_me) still
--   hide, and admits mail under no other name. Untouched.
--   Other vocabularies that only share the word: agent_event.source,
--   connected_account.capability, share.share_type, deal.source,
--   review_request.channel, the search tool's `email` result type.
--
-- Old writers: until every client runs the new build, something may still
-- say `email`. A trigger on the two graph tables rewrites it on the way in,
-- entity_visible_to answers `email` as `email_thread`, and claim_neighborhood
-- hides a mail centre or neighbour under either name. The app reads a
-- retired name the same way (RETIRED_ENTITY_TYPE_NAMES in
-- src/lib/knowledge/entity-registry.ts).
--
-- Idempotent: every rewrite is a no-op once no `email` row is left, the
-- functions are create or replace, the triggers drop-if-exists first. No
-- backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── A kind's current name ───────────────────────────────────────────────────
create or replace function public.entity_kind_current(p_type text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case p_type when 'email' then 'email_thread' else p_type end;
$$;

-- ── The rows ────────────────────────────────────────────────────────────────
-- entity_link: an edge whose renamed twin already exists is a duplicate
-- (the unique key would refuse the rename), and an edge that would point at
-- itself once renamed breaks the self-link CHECK. Both are dropped, then the
-- rest renamed. No trigger on entity_link fires for these columns but the
-- claim/project sync, which only reads claim-to-project edges.
-- Among the edges that share a key once renamed, one already under the
-- current names is kept first, else the oldest.
delete from public.entity_link l
 where (l.source_type = 'email' or l.target_type = 'email')
   and public.entity_kind_current(l.source_type) = public.entity_kind_current(l.target_type)
   and l.source_id = l.target_id;

with touched as (
  select distinct workspace_id, source_id, target_id
    from public.entity_link
   where source_type = 'email' or target_type = 'email'
),
ranked as (
  select l.id,
         (l.source_type = 'email' or l.target_type = 'email') as old_name,
         row_number() over (
           partition by l.workspace_id, public.entity_kind_current(l.source_type), l.source_id,
                        public.entity_kind_current(l.target_type), l.target_id, l.relation
           order by (l.source_type = 'email' or l.target_type = 'email'), l.created_at, l.id
         ) as rn
    from public.entity_link l
    join touched t on t.workspace_id = l.workspace_id and t.source_id = l.source_id and t.target_id = l.target_id
)
delete from public.entity_link l
 using ranked r
 where l.id = r.id and r.old_name and r.rn > 1;

-- Both ends in one statement, so an edge with `email` at each end renames
-- whole.
update public.entity_link
   set source_type = public.entity_kind_current(source_type),
       target_type = public.entity_kind_current(target_type)
 where source_type = 'email' or target_type = 'email';

-- knowledge_package_item: primary key (package_id, entity_type, entity_id).
delete from public.knowledge_package_item k
 where k.entity_type = 'email'
   and exists (
     select 1 from public.knowledge_package_item t
      where t.package_id = k.package_id and t.entity_type = 'email_thread' and t.entity_id = k.entity_id
   );
update public.knowledge_package_item set entity_type = 'email_thread' where entity_type = 'email';

-- anchor_embedding: primary key (workspace_id, entity_type, entity_id).
delete from public.anchor_embedding a
 where a.entity_type = 'email'
   and exists (
     select 1 from public.anchor_embedding t
      where t.workspace_id = a.workspace_id and t.entity_type = 'email_thread' and t.entity_id = a.entity_id
   );
update public.anchor_embedding set entity_type = 'email_thread' where entity_type = 'email';

-- work_touch: the backfill's partial unique key (work_item_id, entity_type,
-- entity_id, verb) for its own two tool names.
delete from public.work_touch w
 where w.entity_type = 'email'
   and w.tool_name in ('backfill', 'declared')
   and exists (
     select 1 from public.work_touch t
      where t.work_item_id = w.work_item_id and t.entity_type = 'email_thread'
        and t.entity_id = w.entity_id and t.verb = w.verb and t.tool_name in ('backfill', 'declared')
   );
update public.work_touch set entity_type = 'email_thread' where entity_type = 'email';

-- No unique key over the kind on these two.
update public.entity_activity set entity_type = 'email_thread' where entity_type = 'email';
update public.attention_item set entity_type = 'email_thread' where entity_type = 'email';

-- ── Old writers to the graph ────────────────────────────────────────────────
-- A row an older build writes with `email` is stored under the current name.
-- BEFORE, so the unique key and the edge rule see the stored value.
create or replace function public.entity_link_current_kinds()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.source_type := public.entity_kind_current(new.source_type);
  new.target_type := public.entity_kind_current(new.target_type);
  return new;
end;
$$;

drop trigger if exists entity_link_current_kinds on public.entity_link;
create trigger entity_link_current_kinds
  before insert or update of source_type, target_type on public.entity_link
  for each row
  when (new.source_type = 'email' or new.target_type = 'email')
  execute function public.entity_link_current_kinds();

create or replace function public.knowledge_package_item_current_kind()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.entity_type := public.entity_kind_current(new.entity_type);
  return new;
end;
$$;

drop trigger if exists knowledge_package_item_current_kind on public.knowledge_package_item;
create trigger knowledge_package_item_current_kind
  before insert or update of entity_type on public.knowledge_package_item
  for each row
  when (new.entity_type = 'email')
  execute function public.knowledge_package_item_current_kind();

revoke all on function public.entity_link_current_kinds() from public, anon, authenticated;
revoke all on function public.knowledge_package_item_current_kind() from public, anon, authenticated;

-- ── Redefined under the current name ────────────────────────────────────────
-- Each object below is the LATEST definition before this migration, copied
-- verbatim except for the rename (web/src/lib/knowledge/__tests__/
-- migration-503.test.ts re-derives each from its source and compares).
-- create or replace keeps every grant and revoke the source left in place,
-- so none is restated here.

-- entity_visible_to, from 500_entity_link_read_follows_endpoints.sql: the kind is read through
-- entity_kind_current first (v_type), and mail is `email_thread`.
create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ws uuid;
  v_member uuid;
  v_vis text;
  v_owner uuid;
  v_created_by uuid;
  v_note uuid;
  v_kind text;
  v_team uuid;
  v_channel uuid;
  v_confirmation text;
  v_type text := public.entity_kind_current(p_type);
begin
  if p_id is null then return false; end if;
  -- A signed-in caller asks only about themself.
  if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;

  if v_type = 'document' then
    select d.workspace_id, d.visibility, d.created_by into v_ws, v_vis, v_created_by
      from public.document d where d.id = p_id;
  elsif v_type = 'capture' then
    select c.workspace_id, c.visibility, c.user_id into v_ws, v_vis, v_owner
      from public.captures c where c.id = p_id;
  elsif v_type = 'contact' then
    select ct.workspace_id into v_ws from public.contact ct where ct.id = p_id;
  elsif v_type = 'company' then
    select co.workspace_id into v_ws from public.company co where co.id = p_id;
  elsif v_type = 'claim' then
    select cl.workspace_id into v_ws from public.claim cl where cl.id = p_id;
  elsif v_type = 'attachment' then
    select a.workspace_id, a.user_id, a.note_id into v_ws, v_owner, v_note
      from public.attachments a where a.id = p_id;
  elsif v_type = 'email_thread' then
    select e.workspace_id, e.user_id into v_ws, v_owner from public.email_thread_index e where e.id = p_id;
  elsif v_type = 'conversation' then
    select cc.workspace_id, cc.user_id into v_ws, v_owner from public.chat_conversations cc where cc.id = p_id;
  elsif v_type = 'calendar_event' then
    select ev.workspace_id, ev.user_id into v_ws, v_owner from public.local_calendar_event ev where ev.id = p_id;
  elsif v_type = 'team_chat_channel' then
    select ch.workspace_id, ch.kind, ch.team_id, ch.id into v_ws, v_kind, v_team, v_channel
      from public.team_chat_channel ch where ch.id = p_id;
  elsif v_type = 'team_chat_message' then
    select ch.workspace_id, ch.kind, ch.team_id, ch.id into v_ws, v_kind, v_team, v_channel
      from public.team_chat_message msg
      join public.team_chat_channel ch on ch.id = msg.channel_id and ch.workspace_id = msg.workspace_id
     where msg.id = p_id;
  elsif v_type = 'decision' then
    select c.workspace_id, c.visibility, c.user_id, dc.confirmation, c.id into v_ws, v_vis, v_owner, v_confirmation, v_note
      from public.decision dc join public.captures c on c.id = dc.capture_id where dc.id = p_id;
  else
    -- Every other kind is every member's: a member of the workspace reads it.
    v_ws := p_workspace;
  end if;

  -- Gone, or not in the workspace asked about: not visible.
  if v_ws is null or (p_workspace is not null and v_ws <> p_workspace) then return false; end if;

  -- No user: the service role asking for no one in particular (an unattended
  -- run, whose output the whole workspace reads). Only what every member of
  -- the workspace reads, the explicit-user twins' own null-user answers. The
  -- private graph kinds (src/lib/knowledge/entity-fences.ts) are no one's to
  -- see on such a run, as that file's fences say.
  if p_user is null then
    if v_type in ('email_thread', 'conversation', 'calendar_event', 'team_chat_channel', 'team_chat_message', 'decision') then return false;
    elsif v_type in ('document', 'capture') then return v_vis = 'workspace';
    elsif v_type = 'contact' then return public.contact_visible_to(p_id, null);
    elsif v_type = 'company' then return public.company_visible_to(p_id, null);
    elsif v_type = 'claim' then return public.claim_visible_to(p_id, null);
    elsif v_type = 'attachment' then
      return v_note is null or exists (select 1 from public.captures c where c.id = v_note and c.visibility = 'workspace');
    end if;
    return true;
  end if;

  -- The kinds that are their owner's alone need no membership read.
  if v_type in ('email_thread', 'conversation', 'calendar_event') then return v_owner = p_user; end if;
  if v_type = 'attachment' and v_owner = p_user then return true; end if;

  select m.id into v_member from public.member m where m.workspace_id = v_ws and m.user_id = p_user limit 1;
  if v_member is null then return false; end if;

  if v_type = 'document' then
    if v_vis = 'workspace' or (v_created_by is not null and v_created_by = v_member) then return true; end if;
    return public.entity_grant_reaches('document', p_id, v_ws, p_user);
  elsif v_type = 'capture' then
    if v_vis = 'workspace' or v_owner = p_user then return true; end if;
    return public.entity_grant_reaches('capture', p_id, v_ws, p_user);
  elsif v_type = 'contact' then
    return public.contact_visible_to(p_id, p_user);
  elsif v_type = 'company' then
    return public.company_visible_to(p_id, p_user);
  elsif v_type = 'claim' then
    return public.claim_visible_to(p_id, p_user);
  elsif v_type = 'attachment' then
    if v_note is null then return true; end if;
    select c.visibility, c.user_id into v_vis, v_owner from public.captures c where c.id = v_note;
    if v_vis is null then return false; end if;
    if v_vis = 'workspace' or v_owner = p_user then return true; end if;
    return public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  elsif v_type in ('team_chat_channel', 'team_chat_message') then
    -- team_chat_can_read (474) for p_user: a team channel is its team's
    -- (every member's when it has none), a DM its members'.
    if v_kind = 'channel' then
      return v_team is null or exists (select 1 from public.team_member tm where tm.team_id = v_team and tm.member_id = v_member);
    end if;
    return v_kind = 'dm' and exists (select 1 from public.team_chat_member cm where cm.channel_id = v_channel and cm.member_id = v_member);
  elsif v_type = 'decision' then
    -- The decision table's view policy (493), through its capture.
    if v_vis = 'workspace' or v_owner = p_user or v_confirmation = 'confirmed' then return true; end if;
    return public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  end if;
  return true;
end;
$$;

-- The entity_link policies that name the mail kind, with `email` renamed in
-- their fenced lists (src/lib/knowledge/entity-fences.ts LINK_FENCED_KINDS; a
-- test holds them equal).
-- From 501_entity_link_read_review_fixes.sql.
drop policy if exists entity_link_select on public.entity_link;
create policy entity_link_select on public.entity_link
  for select
  using (
    public.is_workspace_member(workspace_id)
    and (source_type <> 'claim' or not (source_id in (select private.claims_hidden_from_me())))
    and (target_type <> 'claim' or not (target_id in (select private.claims_hidden_from_me())))
    and (source_type <> 'company' or not (source_id in (select private.companies_hidden_from_me())))
    and (target_type <> 'company' or not (target_id in (select private.companies_hidden_from_me())))
    and (source_type <> all ('{document,capture,contact,attachment,email_thread,conversation,calendar_event,team_chat_channel,team_chat_message,decision}'::text[])
         or public.entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> all ('{document,capture,contact,attachment,email_thread,conversation,calendar_event,team_chat_channel,team_chat_message,decision}'::text[])
         or public.entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

-- From 501_entity_link_read_review_fixes.sql.
drop policy if exists entity_link_insert on public.entity_link;
create policy entity_link_insert on public.entity_link
  for insert
  with check (
    public.is_workspace_member(workspace_id)
    and (source_type <> 'claim' or not (source_id in (select private.claims_hidden_from_me())))
    and (target_type <> 'claim' or not (target_id in (select private.claims_hidden_from_me())))
    and (source_type <> 'company' or not (source_id in (select private.companies_hidden_from_me())))
    and (target_type <> 'company' or not (target_id in (select private.companies_hidden_from_me())))
    and (source_type <> all ('{document,capture,contact,attachment,email_thread,conversation,calendar_event,team_chat_channel,team_chat_message,decision}'::text[])
         or public.entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> all ('{document,capture,contact,attachment,email_thread,conversation,calendar_event,team_chat_channel,team_chat_message,decision}'::text[])
         or public.entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

-- claim_neighborhood, from 369_document_visibility.sql: its mail checks name both
-- `email` and `email_thread`.
CREATE OR REPLACE FUNCTION public.claim_neighborhood(
    p_workspace_id TEXT,
    p_entity_type TEXT,
    p_entity_id TEXT,
    p_depth INTEGER DEFAULT 2,
    p_limit INTEGER DEFAULT 60,
    p_requesting_user_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_workspace_id UUID;
    v_center_id UUID;
    v_depth INTEGER := LEAST(GREATEST(COALESCE(p_depth, 2), 1), 3);
    v_edges JSONB;
    v_nodes JSONB;
    v_requester UUID := public._resolve_visibility_requester(p_requesting_user_id);
BEGIN
    BEGIN
        v_workspace_id := p_workspace_id::UUID;
        v_center_id := p_entity_id::UUID;
    EXCEPTION WHEN others THEN
        RETURN jsonb_build_object(
            'center', jsonb_build_object('type', p_entity_type, 'id', p_entity_id),
            'depth', v_depth,
            'nodes', '[]'::jsonb,
            'edges', '[]'::jsonb
        );
    END;

    -- Membership gate (275): enforced whenever the requester is KNOWN — whether
    -- it came from the JWT or from an explicit p_requesting_user_id — not only
    -- when a JWT happens to be present. A sessionless caller that asserts no
    -- requester at all sees workspace-visible rows only, and is trusted to
    -- scope itself (service-role already has the whole database).
    IF v_requester IS NOT NULL AND NOT public._is_member_of(v_requester, v_workspace_id) THEN
        RETURN jsonb_build_object(
            'center', jsonb_build_object('type', p_entity_type, 'id', v_center_id),
            'depth', v_depth,
            'nodes', '[]'::jsonb,
            'edges', '[]'::jsonb
        );
    END IF;

    -- Asking about a hidden centre returns an empty graph, same shape as the
    -- membership refusal above.
    -- 341: an email centre is hidden from everyone.
    -- 353: someone else's chat is hidden too.
    IF p_entity_type IN ('email', 'email_thread')
       OR (p_entity_type = 'conversation' AND NOT EXISTS (
             SELECT 1 FROM public.chat_conversations cc
             WHERE cc.id = v_center_id AND v_requester IS NOT NULL AND cc.user_id = v_requester))
       OR (p_entity_type = 'capture' AND NOT public.capture_visible_to(v_center_id, v_requester))
       OR (p_entity_type = 'claim' AND NOT public.claim_visible_to(v_center_id, v_requester))
       -- 369: a private document is its creator's alone.
       OR (p_entity_type = 'document' AND NOT public.document_visible_to(v_center_id, v_requester)) THEN
        RETURN jsonb_build_object(
            'center', jsonb_build_object('type', p_entity_type, 'id', v_center_id),
            'depth', v_depth,
            'nodes', '[]'::jsonb,
            'edges', '[]'::jsonb
        );
    END IF;

    WITH RECURSIVE frontier AS (
        SELECT
            p_entity_type AS node_type,
            v_center_id AS node_id,
            0 AS hop,
            ARRAY[p_entity_type || ':' || v_center_id::text] AS visited
        UNION ALL
        SELECT
            nxt.node_type,
            nxt.node_id,
            f.hop + 1,
            f.visited || (nxt.node_type || ':' || nxt.node_id::text)
        FROM frontier f
        JOIN LATERAL (
            SELECT
                CASE WHEN el.source_type = f.node_type AND el.source_id = f.node_id
                     THEN el.target_type ELSE el.source_type END AS node_type,
                CASE WHEN el.source_type = f.node_type AND el.source_id = f.node_id
                     THEN el.target_id ELSE el.source_id END AS node_id
            FROM public.entity_link el
            WHERE el.workspace_id = v_workspace_id
              AND (
                   (el.source_type = f.node_type AND el.source_id = f.node_id)
                OR (el.target_type = f.node_type AND el.target_id = f.node_id)
              )
        ) nxt ON true
        WHERE f.hop < v_depth
          AND NOT ((nxt.node_type || ':' || nxt.node_id::text) = ANY(f.visited))
          AND (nxt.node_type <> 'capture' OR public.capture_visible_to(nxt.node_id, v_requester))
          AND (nxt.node_type <> 'claim'   OR public.claim_visible_to(nxt.node_id, v_requester))
          AND (nxt.node_type <> 'document' OR public.document_visible_to(nxt.node_id, v_requester))
          -- 341: the walk never reaches an email.
          AND nxt.node_type NOT IN ('email', 'email_thread')
          -- 353: nor someone else's chat.
          AND (nxt.node_type <> 'conversation' OR EXISTS (
                SELECT 1 FROM public.chat_conversations cc
                WHERE cc.id = nxt.node_id AND v_requester IS NOT NULL AND cc.user_id = v_requester))
    ),
    reached AS (
        SELECT node_type, node_id, MIN(hop) AS hop
        FROM frontier
        GROUP BY node_type, node_id
    ),
    candidate AS (
        SELECT
            el.source_type, el.source_id, el.target_type, el.target_id,
            el.relation, el.created_at,
            LEAST(rs.hop, rt.hop) AS edge_hop
        FROM public.entity_link el
        JOIN reached rs ON rs.node_type = el.source_type AND rs.node_id = el.source_id
        JOIN reached rt ON rt.node_type = el.target_type AND rt.node_id = el.target_id
        WHERE el.workspace_id = v_workspace_id
    ),
    deg AS (
        SELECT node_type, node_id, COUNT(*)::float AS d
        FROM (
            SELECT source_type AS node_type, source_id AS node_id FROM candidate
            UNION ALL
            SELECT target_type, target_id FROM candidate
        ) u
        GROUP BY node_type, node_id
    ),
    claim_score AS (
        SELECT
            c.id,
            (CASE c.confirmation
                 WHEN 'confirmed' THEN 2.0
                 WHEN 'dismissed' THEN -2.0
                 ELSE 0.0 END)
          + (CASE WHEN c.status = 'active' THEN 1.0 ELSE -1.0 END)
          + COALESCE(c.confidence, 0.5)
          + 1.0 / (1.0 + GREATEST(EXTRACT(EPOCH FROM (now() - c.updated_at)), 0) / (86400.0 * 30.0))
            AS score
        FROM public.claim c
        WHERE c.workspace_id = v_workspace_id
          AND c.id IN (
              SELECT n.node_id FROM (
                  SELECT source_type AS node_type, source_id AS node_id FROM candidate
                  UNION
                  SELECT target_type, target_id FROM candidate
              ) n
              WHERE n.node_type = 'claim'
          )
    ),
    edges AS (
        SELECT cd.source_type, cd.source_id, cd.target_type, cd.target_id, cd.relation
        FROM candidate cd
        LEFT JOIN claim_score ss ON cd.source_type = 'claim' AND ss.id = cd.source_id
        LEFT JOIN claim_score ts ON cd.target_type = 'claim' AND ts.id = cd.target_id
        LEFT JOIN deg ds ON ds.node_type = cd.source_type AND ds.node_id = cd.source_id
        LEFT JOIN deg dt ON dt.node_type = cd.target_type AND dt.node_id = cd.target_id
        ORDER BY
            cd.edge_hop ASC,
            COALESCE(ss.score, 0.5) + COALESCE(ts.score, 0.5)
              + 0.05 * LEAST(COALESCE(ds.d, 0) + COALESCE(dt.d, 0), 20.0) DESC,
            cd.created_at DESC,
            cd.source_id, cd.target_id, cd.relation
        LIMIT p_limit
    )
    SELECT jsonb_agg(jsonb_build_object(
        'source_type', e.source_type,
        'source_id', e.source_id,
        'target_type', e.target_type,
        'target_id', e.target_id,
        'relation', e.relation
    )) INTO v_edges FROM edges e;

    WITH endpoints AS (
        SELECT DISTINCT node_type, node_id FROM (
            SELECT (e->>'source_type') AS node_type, (e->>'source_id')::uuid AS node_id
            FROM jsonb_array_elements(COALESCE(v_edges, '[]'::jsonb)) e
            UNION
            SELECT (e->>'target_type'), (e->>'target_id')::uuid
            FROM jsonb_array_elements(COALESCE(v_edges, '[]'::jsonb)) e
            UNION
            SELECT p_entity_type, v_center_id
        ) u
    )
    SELECT jsonb_agg(jsonb_build_object(
        'node_type', ep.node_type,
        'node_id', ep.node_id,
        'label', CASE ep.node_type
            WHEN 'claim'        THEN LEFT(cl.text, 140)
            WHEN 'capture'      THEN cap.title
            WHEN 'document'     THEN doc.title
            WHEN 'project'      THEN prj.name
            WHEN 'action'       THEN act.title
            WHEN 'contact'      THEN con.full_name
            WHEN 'member'       THEN mem.display_name
            WHEN 'initiative'   THEN ini.name
            WHEN 'attachment'   THEN att.file_name
            WHEN 'conversation' THEN conv.title
            WHEN 'company'      THEN comp.name
            WHEN 'campaign'     THEN camp.name
            ELSE NULL END,
        'claim_text',   CASE WHEN ep.node_type = 'claim' THEN cl.text ELSE NULL END,
        'claim_type',   CASE WHEN ep.node_type = 'claim' THEN cl.type ELSE NULL END,
        'confidence',   CASE WHEN ep.node_type = 'claim' THEN cl.confidence ELSE NULL END,
        'confirmation', CASE WHEN ep.node_type = 'claim' THEN cl.confirmation ELSE NULL END,
        'status',       CASE WHEN ep.node_type = 'claim' THEN cl.status ELSE NULL END
    )) INTO v_nodes
    FROM endpoints ep
    LEFT JOIN public.claim    cl  ON ep.node_type = 'claim'        AND cl.id  = ep.node_id AND cl.workspace_id = v_workspace_id AND public.claim_visible_to(cl.id, v_requester)
    LEFT JOIN public.captures cap ON ep.node_type = 'capture'      AND cap.id = ep.node_id AND cap.workspace_id = v_workspace_id AND (cap.visibility = 'workspace' OR (v_requester IS NOT NULL AND cap.user_id = v_requester))
    LEFT JOIN public.document doc ON ep.node_type = 'document'     AND doc.id = ep.node_id AND doc.workspace_id = v_workspace_id AND public.document_visible_to(doc.id, v_requester)
    LEFT JOIN public.projects prj ON ep.node_type = 'project'      AND prj.id = ep.node_id AND prj.workspace_id = v_workspace_id
    LEFT JOIN public.actions  act ON ep.node_type = 'action'       AND act.id = ep.node_id AND act.workspace_id = v_workspace_id
    LEFT JOIN public.contact  con ON ep.node_type = 'contact'      AND con.id = ep.node_id AND con.workspace_id = v_workspace_id
    LEFT JOIN public.member   mem ON ep.node_type = 'member'       AND mem.id = ep.node_id AND mem.workspace_id = v_workspace_id
    LEFT JOIN public.initiative ini ON ep.node_type = 'initiative' AND ini.id = ep.node_id AND ini.workspace_id = v_workspace_id
    LEFT JOIN public.attachments att ON ep.node_type = 'attachment' AND att.id = ep.node_id AND att.workspace_id = v_workspace_id
    LEFT JOIN public.chat_conversations conv ON ep.node_type = 'conversation' AND conv.id = ep.node_id AND conv.workspace_id = v_workspace_id AND v_requester IS NOT NULL AND conv.user_id = v_requester
    LEFT JOIN public.company  comp ON ep.node_type = 'company'      AND comp.id = ep.node_id AND comp.workspace_id = v_workspace_id
    LEFT JOIN public.campaign camp ON ep.node_type = 'campaign'     AND camp.id = ep.node_id AND camp.workspace_id = v_workspace_id;

    RETURN jsonb_build_object(
        'center', jsonb_build_object('type', p_entity_type, 'id', v_center_id),
        'depth', v_depth,
        'nodes', COALESCE(v_nodes, '[]'::jsonb),
        'edges', COALESCE(v_edges, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

revoke all on function public.entity_kind_current(text) from public, anon;
grant execute on function public.entity_kind_current(text) to authenticated, service_role;

notify pgrst, 'reload schema';
