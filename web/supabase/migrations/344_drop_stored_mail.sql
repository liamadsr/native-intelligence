-- ============================================================
-- 344: drop stored mail (no stored mail, slice 7; the PROD purge)
-- ============================================================
-- IRREVERSIBLE. This migration DELETES the person's stored mail and keeps no
-- copy: every stored message and body, every attachment name, every compose
-- body, every thread subject, preview, display name and recipient list, every
-- sent or dismissed draft, the thread text drafts were generated from, and the
-- mail tool outputs saved in chat history. Nothing here can be undone; a
-- backup taken before it is the only way back. Liam authorized deleting all
-- stored mail from DEV and PROD (2026-10-15).
--
-- Decision, 2026-10-15 (Liam): Dial8 keeps no copy of the person's mail. The
-- ONE exception is the holding pattern (343, email_hold): a thread Dial8
-- drafted a reply to, until the person sends or dismisses the draft. The app
-- reads mail live from Gmail and Graph (src/lib/email/*), and the inbox
-- fetches subjects and previews live (POST /api/account/email/threads/headers).
--
-- Run at low traffic (it rewrites chat history rows and takes table locks),
-- and ONLY after the no-stored-mail code is deployed (it no longer reads or
-- writes anything this drops; the tripwire test
-- src/lib/email/__tests__/no-stored-mail-tripwire.test.ts enforces that) and
-- AFTER 341 (hybrid_search and claim_neighborhood stop joining email_message)
-- and 343 (email_hold). The guards below refuse to run otherwise.
--
-- In order:
--   0. guards: 341 and 343 applied; no other public function still reads a
--      table dropped here.
--   1. reconcile_email_thread_copies (301) is redefined without the dropped
--      index columns and without email_message (same signature and grants).
--   2. the stored-mail functions go: search_email_messages and
--      upsert_email_messages (every overload), the search-vector trigger
--      function and email_message's updated_at trigger function.
--   3. the stored-mail tables go: email_attachment, email_message,
--      email_compose.
--   4. email_thread_index drops subject, snippet, from_name, to_emails and
--      cc_emails (its subject GIN index goes with subject). It keeps ids,
--      flags, timestamps and the sender and participant addresses.
--   5. email_draft: sent and dismissed rows are deleted (sending and
--      dismissing delete them now) and generation_prompt (the wrapped thread)
--      is dropped. Pending drafts with no hold (the person's own words) stay.
--   6. derived rows become templates and pointers: email agent_event facts
--      lose their subject (title) and any display-name sender; email
--      contact_interaction titles become "Email to <contact>"; reply-draft
--      work titles, deliverable labels (tracked_job, agent_run) and agent_log
--      lines lose the subject.
--   7. chat history keeps no mail: a saved read_email, list_emails or
--      get_email_drafts output becomes a pointer (ids and counts).
-- Claims learned from mail are NOT touched here: 341 hides them and 342
-- (claude/mail-claims-leak) purges them.
--
-- Idempotent: every guard reads the catalog; create or replace with the same
-- signature; drop ... if exists; drop column if exists; every update is fenced
-- on what it changes, so a second run changes nothing. This file holds no
-- backslash anywhere: one MCP transport decodes escapes, so the applied SQL
-- would differ from the file.
-- ============================================================

-- SET LOCAL holds for the transaction MCP apply_migration wraps this file in.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30min';

-- ── 0. Guards ───────────────────────────────────────────────────────────────
do $$
declare
  v_name text;
begin
  if to_regclass('public.email_hold') is null then
    raise exception '344 needs 343 (email_hold) applied first';
  end if;
  -- 341: hybrid_search and claim_neighborhood no longer join email_message.
  for v_name in
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('hybrid_search', 'claim_neighborhood')
      and pg_get_functiondef(p.oid) ilike '%email_message%'
  loop
    raise exception '344 needs 341 applied first: % still reads email_message', v_name;
  end loop;
  -- Anything else still reading a table dropped below: a public function (the
  -- ones this migration drops or redefines are left out), a view, or a row
  -- security policy. A word match, so no spacing or quoting hides one.
  for v_name in
    select 'function ' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname not in (
        'search_email_messages', 'upsert_email_messages', 'email_message_search_vector_trigger',
        'update_email_message_updated_at', 'reconcile_email_thread_copies'
      )
      and pg_get_functiondef(p.oid) ~* '(^|[^a-z_])(email_message|email_attachment|email_compose)([^a-z_]|$)'
    union all
    select 'view ' || v.schemaname || '.' || v.viewname
    from pg_views v
    where v.schemaname not in ('pg_catalog', 'information_schema')
      and v.definition ~* '(^|[^a-z_])(email_message|email_attachment|email_compose)([^a-z_]|$)'
    union all
    select 'policy ' || pol.policyname || ' on ' || pol.tablename
    from pg_policies pol
    where pol.tablename not in ('email_message', 'email_attachment', 'email_compose')
      and (coalesce(pol.qual, '') ~* '(^|[^a-z_])(email_message|email_attachment|email_compose)([^a-z_]|$)'
        or coalesce(pol.with_check, '') ~* '(^|[^a-z_])(email_message|email_attachment|email_compose)([^a-z_]|$)')
  loop
    raise exception '344: % still reads stored mail; redefine it first', v_name;
  end loop;
end $$;

-- ── 1. reconcile_email_thread_copies without the dropped columns ────────────
create or replace function public.reconcile_email_thread_copies(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- An account linked nowhere (connected before a workspace was active) keeps
  -- its rows where they are; linking it later reconciles it.
  if not exists (select 1 from connected_account_workspace where account_id = p_account_id) then
    return;
  end if;

  -- The freshest copy of each thread, in any workspace, is the mailbox as last read.
  create temporary table _fresh on commit drop as
  select distinct on (t.provider_thread_id) t.*
  from email_thread_index t
  where t.account_id = p_account_id
  order by t.provider_thread_id, t.synced_at desc nulls last, t.last_message_at desc nulls last,
    t.updated_at desc nulls last, t.id;

  -- 1. Stale copies take the mailbox's state from the freshest one. The
  --    workspace's own links (contact, capture, action, project) stay its own.
  --    Ids, flags and addresses only: no subject or body is stored (344).
  update email_thread_index t set
    provider = f.provider,
    provider_message_id = f.provider_message_id,
    from_email = f.from_email,
    participant_emails = f.participant_emails,
    message_count = f.message_count,
    is_unread = f.is_unread,
    is_starred = f.is_starred,
    has_attachments = f.has_attachments,
    last_message_at = f.last_message_at,
    needs_reply = f.needs_reply,
    auto_classified = f.auto_classified,
    synced_at = f.synced_at,
    history_id = f.history_id,
    folder = f.folder,
    label_ids = f.label_ids,
    is_draft = f.is_draft,
    messages_stored = f.messages_stored,
    message_count_stored = f.message_count_stored,
    total_size_bytes = f.total_size_bytes
  from _fresh f
  where t.account_id = p_account_id
    and t.provider_thread_id = f.provider_thread_id
    and t.id <> f.id
    and (t.provider, t.provider_message_id, t.from_email, t.participant_emails, t.message_count,
         t.is_unread, t.is_starred, t.has_attachments, t.last_message_at, t.needs_reply,
         t.auto_classified, t.synced_at, t.history_id, t.folder, t.label_ids, t.is_draft,
         t.messages_stored, t.message_count_stored, t.total_size_bytes)
      is distinct from
        (f.provider, f.provider_message_id, f.from_email, f.participant_emails, f.message_count,
         f.is_unread, f.is_starred, f.has_attachments, f.last_message_at, f.needs_reply,
         f.auto_classified, f.synced_at, f.history_id, f.folder, f.label_ids, f.is_draft,
         f.messages_stored, f.message_count_stored, f.total_size_bytes);

  -- 2. Every linked workspace without a copy gets one, its contact link that
  --    workspace's own contact for the sender (as the sync links it).
  insert into email_thread_index (
    workspace_id, user_id, account_id, provider, provider_thread_id, provider_message_id,
    from_email, participant_emails,
    message_count, is_unread, is_starred, has_attachments, last_message_at, needs_reply,
    auto_classified, linked_contact_id, synced_at, history_id, folder, label_ids, is_draft,
    messages_stored, message_count_stored, total_size_bytes
  )
  select
    j.workspace_id, f.user_id, f.account_id, f.provider, f.provider_thread_id, f.provider_message_id,
    f.from_email, f.participant_emails,
    f.message_count, f.is_unread, f.is_starred, f.has_attachments, f.last_message_at, f.needs_reply,
    f.auto_classified,
    (select c.id from contact c
      where c.workspace_id = j.workspace_id and c.email = lower(f.from_email)
      order by c.id limit 1),
    f.synced_at, f.history_id, f.folder, f.label_ids, f.is_draft,
    f.messages_stored, f.message_count_stored, f.total_size_bytes
  from _fresh f
  join connected_account_workspace j on j.account_id = p_account_id
  where not exists (
    select 1 from email_thread_index t
    where t.workspace_id = j.workspace_id
      and t.account_id = p_account_id
      and t.provider_thread_id = f.provider_thread_id
  )
  on conflict do nothing;

  -- 3. Copies in workspaces the account is no longer linked to go. A draft
  --    pointing at one moves first: to its own workspace's copy of the thread
  --    when there is one, else to a linked workspace's.
  update email_draft d set email_thread_id = coalesce(
    (select k.id from email_thread_index k
      where k.account_id = p_account_id and k.provider_thread_id = t.provider_thread_id
        and k.workspace_id = d.workspace_id
        and exists (select 1 from connected_account_workspace j
                    where j.account_id = p_account_id and j.workspace_id = k.workspace_id)
      limit 1),
    (select k.id from email_thread_index k
      join connected_account_workspace j on j.account_id = p_account_id and j.workspace_id = k.workspace_id
      where k.account_id = p_account_id and k.provider_thread_id = t.provider_thread_id
      order by k.id limit 1))
  from email_thread_index t
  where d.email_thread_id = t.id
    and t.account_id = p_account_id
    and not exists (select 1 from connected_account_workspace j
                    where j.account_id = p_account_id and j.workspace_id = t.workspace_id);

  delete from email_thread_index t
  where t.account_id = p_account_id
    and not exists (select 1 from connected_account_workspace j
                    where j.account_id = p_account_id and j.workspace_id = t.workspace_id);

  drop table _fresh;
end;
$$;

revoke execute on function public.reconcile_email_thread_copies(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_email_thread_copies(uuid) to service_role;

-- ── 2. The stored-mail RPCs, then the tables, then their trigger functions ─
-- RESTRICT throughout: an object this migration does not know about that
-- depends on one of these aborts the run instead of vanishing with it. The
-- tables' own triggers, indexes and policies go with each table.
do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('search_email_messages', 'upsert_email_messages')
  loop
    execute format('drop function if exists %s restrict', v_fn);
  end loop;
end $$;

-- ── 3. The stored-mail tables (email_attachment first: it references email_message)
drop table if exists public.email_attachment restrict;
drop table if exists public.email_message restrict;
drop table if exists public.email_compose restrict;

do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('email_message_search_vector_trigger', 'update_email_message_updated_at')
  loop
    execute format('drop function if exists %s restrict', v_fn);
  end loop;
end $$;

-- ── 4. The thread index keeps ids, flags and addresses only ─────────────────
drop index if exists public.email_thread_subject_search_idx;
alter table public.email_thread_index drop column if exists subject;
alter table public.email_thread_index drop column if exists snippet;
alter table public.email_thread_index drop column if exists from_name;
alter table public.email_thread_index drop column if exists to_emails;
alter table public.email_thread_index drop column if exists cc_emails;

comment on table public.email_thread_index is
  'One row per mail thread per linked workspace: ids, flags, timestamps and the sender and participant addresses only (344). Subjects and previews are read live from the provider; the one stored copy of received mail is email_hold (343).';

-- ── 5. Drafts ───────────────────────────────────────────────────────────────
-- Sent and dismissed rows go (sending and dismissing delete them now). A
-- pending draft with no hold is the person's own words (compose, outreach, a
-- capture's follow-up proposal): it quotes no received mail and stays.
delete from public.email_draft where status in ('sent', 'dismissed');
alter table public.email_draft drop column if exists generation_prompt;

-- ── 6. Derived rows: templates and pointers ─────────────────────────────────
-- The agent's inbox: a mail row keeps the sender's address, the contact and
-- the reason, never a subject or a display name.
update public.agent_event
set facts = facts - 'title'
where kind in ('email.drafted', 'email.needs_reply', 'email.suspicious')
  and facts ? 'title';

update public.agent_event
set facts = facts - 'from'
where kind in ('email.drafted', 'email.needs_reply', 'email.suspicious')
  and facts ? 'from'
  and position('@' in coalesce(facts ->> 'from', '')) = 0;

-- Contact timelines (readable by the whole workspace): a template title. A
-- sent email names its contact; a received one is "Email received"; a
-- sequence's own "Sequence email sent" is already a template and stays.
update public.contact_interaction ci
set title = coalesce('Email to ' || left(nullif(trim(c.full_name), ''), 120), 'Email sent')
from public.contact c
where c.id = ci.contact_id
  and ci.interaction_type = 'email_sent'
  and ci.title is distinct from 'Sequence email sent'
  and ci.title is distinct from coalesce('Email to ' || left(nullif(trim(c.full_name), ''), 120), 'Email sent');

update public.contact_interaction
set title = 'Email received'
where interaction_type = 'email_received'
  and title is distinct from 'Email received';

-- Reply-draft work items: the subject leaves the title and every draft label.
update public.tracked_job
set title = 'Reply draft for a new email'
where kind = 'email_drafts'
  and title like 'Reply draft: %';

update public.tracked_job t
set deliverables = (
  select jsonb_agg(
    case when e.d ->> 'type' = 'email_draft' and e.d ? 'label'
      then jsonb_set(e.d, '{label}', to_jsonb('Reply draft'::text))
      else e.d end
    order by e.ord)
  from jsonb_array_elements(t.deliverables) with ordinality as e(d, ord)
)
where jsonb_typeof(t.deliverables) = 'array'
  and exists (
    select 1 from jsonb_array_elements(t.deliverables) as x(d)
    where x.d ->> 'type' = 'email_draft' and x.d ? 'label' and x.d ->> 'label' is distinct from 'Reply draft'
  );

update public.agent_run r
set deliverables = (
  select jsonb_agg(
    case when e.d ->> 'type' = 'email_draft' and e.d ? 'label'
      then jsonb_set(e.d, '{label}', to_jsonb('Reply draft'::text))
      else e.d end
    order by e.ord)
  from jsonb_array_elements(r.deliverables) with ordinality as e(d, ord)
)
where jsonb_typeof(r.deliverables) = 'array'
  and exists (
    select 1 from jsonb_array_elements(r.deliverables) as x(d)
    where x.d ->> 'type' = 'email_draft' and x.d ? 'label' and x.d ->> 'label' is distinct from 'Reply draft'
  );

-- The agent's log lines that quoted a reply draft's subject: only the work
-- lines of a reply-draft work item (a person's own titles are never touched).
update public.agent_log l
set line = regexp_replace(l.line, 'Reply draft: .*$', 'Reply draft for a new email')
where l.kind like 'work_%'
  and l.ref_type = 'work_item'
  and l.line like '%Reply draft: %'
  and exists (select 1 from public.tracked_job t where t.id::text = l.ref_id and t.kind = 'email_drafts');

-- ── 7. Chat history keeps no mail ───────────────────────────────────────────
-- A saved mail tool output (read_email, list_emails, get_email_drafts) becomes
-- its pointer: success, the thread and message ids and counts. In any other
-- output, a mail row loses its sender-written text: a search / find email row
-- (result_type 'email') keeps its id, a mail card item (show / read_card: a
-- thread_id with a subject) and a contact's or company's recent_email_threads
-- keep ids, dates and flags. AI SDK v5+ parts (tool-NAME, dynamic-tool) and v4
-- tool-invocation parts are both read. The helpers live in pg_temp: they
-- vanish with the session and leave nothing behind.

create or replace function pg_temp.mail_row(r jsonb) returns jsonb
language sql immutable as $fn$
  select (r - 'subject' - 'snippet' - 'from_name' - 'preview' - 'body' - 'body_text' - 'metadata')
    || jsonb_build_object('scrubbed', 'mail')
$fn$;

create or replace function pg_temp.scrub_mail_rows(j jsonb) returns jsonb
language plpgsql immutable as $fn$
declare
  k text;
  v jsonb;
  out jsonb;
begin
  if j is null then
    return null;
  elsif jsonb_typeof(j) = 'array' then
    select coalesce(jsonb_agg(pg_temp.scrub_mail_rows(e.x) order by e.ord), '[]'::jsonb)
      into out
      from jsonb_array_elements(j) with ordinality as e(x, ord);
    return out;
  elsif jsonb_typeof(j) <> 'object' then
    return j;
  end if;
  if j ->> 'result_type' = 'email' then
    return jsonb_strip_nulls(jsonb_build_object(
      'result_type', 'email', 'result_id', j -> 'result_id', 'event_at', j -> 'event_at', 'title', 'Email', 'scrubbed', 'mail'));
  end if;
  if jsonb_typeof(j -> 'thread_id') = 'string' and (j ? 'subject' or j ? 'snippet') then
    return pg_temp.mail_row(j);
  end if;
  out := '{}'::jsonb;
  for k, v in select * from jsonb_each(j) loop
    if k = 'recent_email_threads' and jsonb_typeof(v) = 'array' then
      select coalesce(jsonb_agg(case when jsonb_typeof(e.x) = 'object' then pg_temp.mail_row(e.x) else e.x end order by e.ord), '[]'::jsonb)
        into v
        from jsonb_array_elements(v) with ordinality as e(x, ord);
    else
      v := pg_temp.scrub_mail_rows(v);
    end if;
    out := out || jsonb_build_object(k, v);
  end loop;
  return out;
end;
$fn$;

create or replace function pg_temp.mail_pointer(o jsonb) returns jsonb
language sql immutable as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'scrubbed', 'mail',
    'success', o -> 'success',
    'thread_id', o -> 'thread_id',
    'last_message_id', o -> 'last_message_id',
    'message_count', o -> 'message_count',
    'count', o -> 'count'
  ))
$fn$;

create or replace function pg_temp.is_mail_tool(name text) returns boolean
language sql immutable as $fn$
  -- A whole tool name, or one prefixed by a namespace (dial8_read_email, x.read_email), as in TypeScript.
  select coalesce(name, '') ~ '(^|[_.])(read_email|list_emails|get_email_drafts)$'
$fn$;

create or replace function pg_temp.scrub_mail_part(p jsonb) returns jsonb
language plpgsql immutable as $fn$
declare
  inv jsonb;
  mail boolean;
begin
  if jsonb_typeof(p) <> 'object' then
    return p;
  end if;
  if p ->> 'type' = 'tool-invocation' and jsonb_typeof(p -> 'toolInvocation') = 'object' then
    inv := p -> 'toolInvocation';
    if inv ? 'result' then
      inv := jsonb_set(inv, '{result}',
        case when pg_temp.is_mail_tool(inv ->> 'toolName') then pg_temp.mail_pointer(inv -> 'result') else pg_temp.scrub_mail_rows(inv -> 'result') end);
    end if;
    return jsonb_set(p, '{toolInvocation}', inv);
  end if;
  mail := (p ->> 'type' like 'tool-%' and pg_temp.is_mail_tool(substr(p ->> 'type', 6)))
    or pg_temp.is_mail_tool(p ->> 'toolName');
  if p ? 'output' then
    p := jsonb_set(p, '{output}', case when mail then pg_temp.mail_pointer(p -> 'output') else pg_temp.scrub_mail_rows(p -> 'output') end);
  end if;
  if p ? 'result' then
    p := jsonb_set(p, '{result}', case when mail then pg_temp.mail_pointer(p -> 'result') else pg_temp.scrub_mail_rows(p -> 'result') end);
  end if;
  return p;
end;
$fn$;

update public.chat_messages m
set ui_message = jsonb_set(m.ui_message, '{parts}', (
  select coalesce(jsonb_agg(pg_temp.scrub_mail_part(e.p) order by e.ord), '[]'::jsonb)
  from jsonb_array_elements(m.ui_message -> 'parts') with ordinality as e(p, ord)
))
where jsonb_typeof(m.ui_message -> 'parts') = 'array'
  and (m.ui_message -> 'parts')::text ~ '(read_email|list_emails|get_email_drafts|"result_type": "email"|"thread_id"|recent_email_threads)'
  and (m.ui_message -> 'parts') is distinct from (
    select coalesce(jsonb_agg(pg_temp.scrub_mail_part(e.p) order by e.ord), '[]'::jsonb)
    from jsonb_array_elements(m.ui_message -> 'parts') with ordinality as e(p, ord)
  );

-- ============================================================
-- Checks (run by hand; not part of the migration)
-- ============================================================
--
-- PRE-CHECK, before applying. Note every number: the post-check compares.
-- The md5 is of every chat row the scrub's prefilter leaves alone: the
-- post-check's must be identical.
--
-- SELECT
--   (SELECT count(*) FROM public.email_message) AS messages,
--   (SELECT count(*) FROM public.email_attachment) AS attachments,
--   (SELECT count(*) FROM public.email_compose) AS composes,
--   (SELECT count(*) FROM public.email_draft WHERE status IN ('sent', 'dismissed')) AS settled_drafts,
--   (SELECT count(*) FROM public.email_draft WHERE status NOT IN ('sent', 'dismissed')) AS open_drafts_kept,
--   (SELECT count(*) FROM public.email_thread_index) AS thread_rows,
--   (SELECT count(*) FROM public.email_hold) AS holds,
--   (SELECT count(*) FROM public.chat_messages m
--     WHERE jsonb_typeof(m.ui_message -> 'parts') = 'array'
--       AND (m.ui_message -> 'parts')::text ~ '(read_email|list_emails|get_email_drafts|"result_type": "email"|"thread_id"|recent_email_threads)'
--   ) AS chat_scrub_candidates,
--   (SELECT md5(coalesce(string_agg(m.ui_message::text, '' ORDER BY m.id), ''))
--     FROM public.chat_messages m
--     WHERE NOT (jsonb_typeof(m.ui_message -> 'parts') = 'array'
--       AND (m.ui_message -> 'parts')::text ~ '(read_email|list_emails|get_email_drafts|"result_type": "email"|"thread_id"|recent_email_threads)')
--   ) AS untouched_chat_md5;
--
-- POST-CHECK, after applying. The three tables and five columns are gone,
-- no mail tool part carries a subject, preview or body, settled drafts are 0,
-- open_drafts_kept, thread_rows and holds equal the pre-check's, and
-- untouched_chat_md5 equals the pre-check's.
--
-- SELECT
--   to_regclass('public.email_message') IS NULL
--     AND to_regclass('public.email_attachment') IS NULL
--     AND to_regclass('public.email_compose') IS NULL AS tables_gone,
--   (SELECT count(*) FROM information_schema.columns
--     WHERE table_schema = 'public'
--       AND ((table_name = 'email_thread_index' AND column_name IN ('subject', 'snippet', 'from_name', 'to_emails', 'cc_emails'))
--         OR (table_name = 'email_draft' AND column_name = 'generation_prompt'))) AS dropped_columns_left,
--   (SELECT count(*) FROM public.email_draft WHERE status IN ('sent', 'dismissed')) AS settled_drafts_left,
--   (SELECT count(*) FROM public.email_draft WHERE status NOT IN ('sent', 'dismissed')) AS open_drafts_kept,
--   (SELECT count(*) FROM public.email_thread_index) AS thread_rows,
--   (SELECT count(*) FROM public.email_hold) AS holds,
--   (SELECT count(*) FROM public.chat_messages m, jsonb_array_elements(m.ui_message -> 'parts') p
--     WHERE jsonb_typeof(m.ui_message -> 'parts') = 'array'
--       AND (coalesce(p ->> 'type', '') ~ '(^|[-_.])(read_email|list_emails|get_email_drafts)$'
--         OR coalesce(p ->> 'toolName', '') ~ '(^|[_.])(read_email|list_emails|get_email_drafts)$'
--         OR coalesce(p -> 'toolInvocation' ->> 'toolName', '') ~ '(^|[_.])(read_email|list_emails|get_email_drafts)$')
--       AND coalesce(p -> 'output', p -> 'result', p -> 'toolInvocation' -> 'result', 'null'::jsonb)::text ~ '"(subject|snippet|body_text)"'
--   ) AS mail_parts_with_text_left,
--   (SELECT md5(coalesce(string_agg(m.ui_message::text, '' ORDER BY m.id), ''))
--     FROM public.chat_messages m
--     WHERE NOT (jsonb_typeof(m.ui_message -> 'parts') = 'array'
--       AND (m.ui_message -> 'parts')::text ~ '(read_email|list_emails|get_email_drafts|"result_type": "email"|"thread_id"|recent_email_threads)')
--   ) AS untouched_chat_md5;
