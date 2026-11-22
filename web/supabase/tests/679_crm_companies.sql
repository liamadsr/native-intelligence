-- DB-level test for migration 679: pipelines of companies or contacts, and
-- discussion on a company with the company's own visibility. (Stages, owner
-- and revenue are run in 680_company_team_email.sql.)
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/679_crm_companies.sql
-- Prints "679 crm_companies: all checks passed". One transaction, rolled
-- back. Made-up people only (example.test). A failed check raises.

begin;

-- Rows here are written directly (the app writes them through apply_data_ops,
-- which numbers them): any position does, inside this rolled-back test.
alter table public.data_row alter column position set default 0;

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $f$;

create or replace function pg_temp.as_service() returns void language plpgsql as $f$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $f$;

do $probe$
declare
  u_alice constant uuid := '00000000-0000-4000-8000-000000679001';
  u_bob   constant uuid := '00000000-0000-4000-8000-000000679002';
  ws uuid; m_alice uuid; m_bob uuid;
  acme uuid; beta uuid; pat uuid; pat2 uuid;
  deals uuid; cos uuid; people uuid;
  r1 uuid; r2 uuid; c_id uuid;
  res jsonb;
  failed boolean;
  n int;
begin
  insert into auth.users (id, email) values (u_alice, 'alice@team679.example.test'), (u_bob, 'bob@team679.example.test');
  insert into public.workspace (name, slug) values ('Probe 679', 'probe-679-' || substr(md5(random()::text), 1, 8)) returning id into ws;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_alice, ws, 'admin', 'Alice Probe') returning id into m_alice;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_bob, ws, 'member', 'Bob Probe') returning id into m_bob;
  insert into public.company (workspace_id, name, domain) values (ws, 'Acme Probe', 'acme679.example.test') returning id into acme;
  insert into public.contact (workspace_id, full_name, email, company_id, visibility, created_by_member_id)
  values (ws, 'Pat Example', 'pat@acme679.example.test', acme, 'workspace', m_alice) returning id into pat;
  insert into public.contact (workspace_id, full_name, email, visibility, created_by_member_id)
  values (ws, 'Pat Example (dup)', 'pat2@acme679.example.test', 'workspace', m_alice) returning id into pat2;
  insert into public.company (workspace_id, name) values (ws, 'Beta Probe') returning id into beta;
  insert into public.contact (workspace_id, full_name, company_id, visibility, created_by_member_id)
  values (ws, 'Robin Example', beta, 'private', m_alice);

  -- ── C. Pipelines of records ──
  perform pg_temp.as_user(u_alice);
  res := public.create_record_pipeline(ws, 'Partners', 'company');
  cos := (res ->> 'table_id')::uuid;
  res := public.create_record_pipeline(ws, 'Hiring', 'contact');
  people := (res ->> 'table_id')::uuid;
  res := public.create_pipeline(ws, 'Sales probe');
  deals := (res ->> 'table_id')::uuid;
  perform pg_temp.as_service();
  if (select record_kind from public.data_table where id = cos) is distinct from 'company' then raise exception 'FAIL: a companies pipeline'; end if;
  if (select record_kind from public.data_table where id = deals) is not null then raise exception 'FAIL: a deal pipeline has no record kind'; end if;
  if (select to_jsonb(options) from public.custom_field_definition where table_id = people and key = 'stage') is distinct from '["New", "Screening", "Interview", "Offer", "Hired", "Declined"]'::jsonb then
    raise exception 'FAIL: a contacts pipeline starts with its own stages';
  end if;
  failed := false;
  begin update public.data_table set is_default = false where workspace_id = ws; update public.data_table set is_default = true where id = cos; exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: a pipeline of records is never the default'; end if;
  failed := false;
  begin perform public.create_record_pipeline(ws, 'Nope', 'deal'); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: only company or contact'; end if;

  -- A row names its record; the title starts as the record's name.
  insert into public.data_row (workspace_id, table_id, title, custom_fields, created_by_user_id)
  values (ws, cos, '', jsonb_build_object('company', jsonb_build_array(acme), 'stage', 'Contacted'), u_alice) returning id into r1;
  if (select record_id from public.data_row where id = r1) is distinct from acme then raise exception 'FAIL: the row points to Acme'; end if;
  if (select title from public.data_row where id = r1) <> 'Acme Probe' then raise exception 'FAIL: the title is the company''s name'; end if;
  failed := false;
  begin insert into public.data_row (workspace_id, table_id, title, custom_fields) values (ws, cos, 'x', '{}'); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: a row with no record is refused'; end if;
  failed := false;
  begin insert into public.data_row (workspace_id, table_id, title, custom_fields) values (ws, cos, '', jsonb_build_object('company', jsonb_build_array(acme))); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: one company once per pipeline'; end if;
  -- The same company in another pipeline is fine; a deal pipeline is untouched.
  perform pg_temp.as_user(u_alice);
  res := public.create_record_pipeline(ws, 'Partners 2', 'company');
  perform pg_temp.as_service();
  insert into public.data_row (workspace_id, table_id, title, custom_fields) values (ws, (res ->> 'table_id')::uuid, '', jsonb_build_object('company', jsonb_build_array(acme)));
  insert into public.data_row (workspace_id, table_id, title, custom_fields) values (ws, deals, 'Deal A', jsonb_build_object('company', jsonb_build_array(acme)));
  insert into public.data_row (workspace_id, table_id, title, custom_fields) values (ws, deals, 'Deal B', jsonb_build_object('company', jsonb_build_array(acme)));
  if exists (select 1 from public.data_row where table_id = deals and record_id is not null) then raise exception 'FAIL: deal rows keep no record'; end if;
  -- An archived row frees its record.
  update public.data_row set archived_at = now() where id = r1;
  insert into public.data_row (workspace_id, table_id, title, custom_fields) values (ws, cos, '', jsonb_build_object('company', jsonb_build_array(acme)));

  -- Contacts: one person per row; two rows that become one person: the second archives.
  insert into public.data_row (workspace_id, table_id, title, custom_fields) values (ws, people, '', jsonb_build_object('contacts', jsonb_build_array(pat))) returning id into r1;
  insert into public.data_row (workspace_id, table_id, title, custom_fields) values (ws, people, '', jsonb_build_object('contacts', jsonb_build_array(pat2))) returning id into r2;
  if (select title from public.data_row where id = r1) <> 'Pat Example' then raise exception 'FAIL: the title is the person''s name'; end if;
  failed := false;
  begin insert into public.data_row (workspace_id, table_id, title, custom_fields) values (ws, people, '', jsonb_build_object('contacts', jsonb_build_array(pat, pat2))); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: one person per row'; end if;
  update public.data_row set custom_fields = jsonb_build_object('contacts', jsonb_build_array(pat)) where id = r2;
  if (select archived_at from public.data_row where id = r2) is null then raise exception 'FAIL: a merge into a person already there archives the second row'; end if;

  -- ── B. Discussion ──
  perform pg_temp.as_user(u_bob);
  insert into public.comment (body, author_id, commentable_type, commentable_id) values ('Probe note', m_bob, 'company', acme) returning id into c_id;
  if not exists (select 1 from public.comment where id = c_id) then raise exception 'FAIL: Bob reads his comment on Acme'; end if;
  failed := false;
  begin insert into public.comment (body, author_id, commentable_type, commentable_id) values ('Nope', m_bob, 'company', beta); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: no comment on a company Bob can''t see'; end if;
  failed := false;
  begin insert into public.comment (body, author_id, commentable_type, commentable_id) values ('Not me', m_alice, 'company', acme); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: a comment is written as oneself only'; end if;
  perform pg_temp.as_user(u_alice);
  insert into public.comment (body, author_id, commentable_type, commentable_id) values ('Beta note', m_alice, 'company', beta);
  perform pg_temp.as_user(u_bob);
  select count(*) into n from public.comment where commentable_type::text = 'company' and commentable_id = beta;
  if n <> 0 then raise exception 'FAIL: Bob reads no comment on Beta'; end if;
  perform pg_temp.as_service();
  failed := false;
  begin insert into public.comment (body, author_id, commentable_type, commentable_id) values ('ghost', m_alice, 'company', gen_random_uuid()); exception when others then failed := true; end;
  if not failed then raise exception 'FAIL: a comment on a company that doesn''t exist is refused'; end if;
  if not exists (select 1 from public.entity_activity where entity_type = 'company' and entity_id = acme and action = 'commented') then
    raise exception 'FAIL: a company comment is in its activity';
  end if;
  -- A notification may point at a company now.
  insert into public.notification (workspace_id, recipient_id, type, title, target_type, target_id)
  values (ws, m_bob, 'mentioned', 'probe', 'company', acme);

  raise notice '679 crm_companies: all checks passed';
end;
$probe$;

rollback;
