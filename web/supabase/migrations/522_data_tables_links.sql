-- ============================================================
-- 522: an edge to a table or a row is read as the table is (Tables, phase 1).
-- ============================================================
-- 500, 501 and 503 made an entity_link row readable only by someone who may
-- read both of its ends: a kind with a per-record rule is in the policies'
-- fenced lists and answered by entity_visible_to; every other kind is every
-- member's. A table can be private (520), and a row is its table's, so both
-- join the lists: a mention of a private table's row, or a link to it, is
-- hidden from whoever can't read the table, and nobody can write one to a
-- table they can't read (the insert policy asks the read rule, 501).
-- entity_visible_to's table arms are 600 (numbered after 572, which restated
-- it); apply 600 with this.
--
-- Each policy below is 503's with only the two kinds added
-- (src/lib/knowledge/__tests__/migration-522.test.ts compares them).
--
-- After 503 and 520. Idempotent (drop policy if exists). No backslashes
-- anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- From 503_one_name_for_mail.sql, with data_table and data_row in both lists.
drop policy if exists entity_link_select on public.entity_link;
create policy entity_link_select on public.entity_link
  for select
  using (
    public.is_workspace_member(workspace_id)
    and (source_type <> 'claim' or not (source_id in (select private.claims_hidden_from_me())))
    and (target_type <> 'claim' or not (target_id in (select private.claims_hidden_from_me())))
    and (source_type <> 'company' or not (source_id in (select private.companies_hidden_from_me())))
    and (target_type <> 'company' or not (target_id in (select private.companies_hidden_from_me())))
    and (source_type <> all ('{document,capture,contact,attachment,email_thread,conversation,calendar_event,team_chat_channel,team_chat_message,decision,data_table,data_row}'::text[])
         or public.entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> all ('{document,capture,contact,attachment,email_thread,conversation,calendar_event,team_chat_channel,team_chat_message,decision,data_table,data_row}'::text[])
         or public.entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

-- From 503_one_name_for_mail.sql, with data_table and data_row in both lists.
drop policy if exists entity_link_insert on public.entity_link;
create policy entity_link_insert on public.entity_link
  for insert
  with check (
    public.is_workspace_member(workspace_id)
    and (source_type <> 'claim' or not (source_id in (select private.claims_hidden_from_me())))
    and (target_type <> 'claim' or not (target_id in (select private.claims_hidden_from_me())))
    and (source_type <> 'company' or not (source_id in (select private.companies_hidden_from_me())))
    and (target_type <> 'company' or not (target_id in (select private.companies_hidden_from_me())))
    and (source_type <> all ('{document,capture,contact,attachment,email_thread,conversation,calendar_event,team_chat_channel,team_chat_message,decision,data_table,data_row}'::text[])
         or public.entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> all ('{document,capture,contact,attachment,email_thread,conversation,calendar_event,team_chat_channel,team_chat_message,decision,data_table,data_row}'::text[])
         or public.entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );
