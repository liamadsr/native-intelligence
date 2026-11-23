
-- ============================================================
-- E2E (rolled back): fixtures, refusals, merge, assertions
-- ============================================================
CREATE TABLE pg_temp.e2e (k text PRIMARY KEY, v uuid);
CREATE TABLE pg_temp.e2e_out (k text PRIMARY KEY, j jsonb);

DO $$
DECLARE
  u1 uuid := '51ea9b3e-4a5b-4327-bba9-4564aa43e6ee';
  u2 uuid := '77ae2021-97a1-4506-971e-955e4c8de9ce';
  u3 uuid := '2303bec2-70a1-433e-878b-24b33e054439';
  s uuid; d uuid;
  s_gen uuid; d_gen uuid; s_mkt uuid; d_mkt uuid; s_dsg uuid;
  s_gen_todo uuid; s_mkt_todo uuid; s_mkt_qa uuid; d_mkt_todo uuid; d_gen_todo uuid; s_dsg_todo uuid;
  m1s uuid; m1d uuid; m2s uuid; m2d uuid; m3s uuid;
  a1 uuid; a2 uuid; a3 uuid; a_xyz uuid; a_mkt1 uuid; a_mkt2 uuid; a_qa uuid; a_dsg uuid; a_default uuid; d_a_xyz uuid; d_a_mkt1 uuid;
  l_bug_s uuid; l_bug_d uuid; l_design_s uuid;
  c1s uuid; c1d uuid; c2s uuid; co_acme_s uuid; co_acme_d uuid; co_ws_s uuid; co_ws_d uuid;
  cap_s uuid;
  acct uuid; acct_lin_s uuid; acct_lin_d uuid; acct_jira_s uuid;
  t1s uuid; t1d uuid; t2s uuid;
  f_triage_s uuid; f_triage_d uuid; f_other_s uuid;
  bot_mail_s uuid; bot_mail_d uuid;
  conv_home_s uuid; conv_home_d uuid; conv_bot_s uuid; conv_bot_d uuid; conv_eve_s uuid;
  doc_prod_s uuid; doc_prod_d uuid; doc_road_s uuid; doc_road_d uuid;
  view_s uuid; view_d uuid;
  claim_s uuid;
  proj_def_s uuid; proj_def_d uuid;
  cyc_s uuid; cyc_d uuid;
  seq_s uuid; seq_d uuid; enr_s uuid; enr_s2 uuid; enr_s3 uuid; enr_d3 uuid; c3s uuid; c3d uuid;
  cap_stale uuid; run_pr uuid; run_wait uuid; job_review uuid;
BEGIN
  INSERT INTO public.workspace (name, slug) VALUES ('Coherix E2E', 'coherix-e2e-' || left(gen_random_uuid()::text, 8)) RETURNING id INTO s;
  INSERT INTO public.workspace (name, slug) VALUES ('Home E2E', 'home-e2e-' || left(gen_random_uuid()::text, 8)) RETURNING id INTO d;
  INSERT INTO pg_temp.e2e VALUES ('s', s), ('d', d), ('u1', u1), ('u2', u2), ('u3', u3);

  -- people: u1 owner of both; u2 member in s, admin in d; u3 only in s
  INSERT INTO public.member (user_id, workspace_id, role, display_name) VALUES (u1, s, 'owner', 'U1') RETURNING id INTO m1s;
  INSERT INTO public.member (user_id, workspace_id, role, display_name) VALUES (u1, d, 'owner', 'U1') RETURNING id INTO m1d;
  INSERT INTO public.member (user_id, workspace_id, role, display_name) VALUES (u2, s, 'member', 'U2') RETURNING id INTO m2s;
  INSERT INTO public.member (user_id, workspace_id, role, display_name) VALUES (u2, d, 'admin', 'U2') RETURNING id INTO m2d;
  INSERT INTO public.member (user_id, workspace_id, role, display_name) VALUES (u3, s, 'member', 'U3') RETURNING id INTO m3s;
  INSERT INTO pg_temp.e2e VALUES ('m1d', m1d), ('m2d', m2d), ('m3s', m3s), ('m2s', m2s), ('m1s', m1s);
  INSERT INTO public.invite (workspace_id, email, invited_by) VALUES (s, 'invitee-e2e@example.com', m1s);

  -- teams: the auto-created General on both; s adds Design (DSG, free) and Marketing (MKT, also in d)
  SELECT id INTO s_gen FROM public.team WHERE workspace_id = s ORDER BY created_at LIMIT 1;
  SELECT id INTO d_gen FROM public.team WHERE workspace_id = d ORDER BY created_at LIMIT 1;
  INSERT INTO public.team (workspace_id, name, slug, issue_prefix) VALUES (s, 'Design', 'design', 'DSG') RETURNING id INTO s_dsg;
  INSERT INTO public.team (workspace_id, name, slug, issue_prefix) VALUES (s, 'Marketing', 'marketing', 'MKT') RETURNING id INTO s_mkt;
  INSERT INTO public.team (workspace_id, name, slug, issue_prefix) VALUES (d, 'Marketing', 'marketing', 'MKT') RETURNING id INTO d_mkt;
  INSERT INTO pg_temp.e2e VALUES ('s_gen', s_gen), ('d_gen', d_gen), ('s_mkt', s_mkt), ('d_mkt', d_mkt), ('s_dsg', s_dsg);
  SELECT id INTO s_gen_todo FROM public.workflow_state WHERE team_id = s_gen AND is_default;
  SELECT id INTO d_gen_todo FROM public.workflow_state WHERE team_id = d_gen AND is_default;
  SELECT id INTO s_mkt_todo FROM public.workflow_state WHERE team_id = s_mkt AND is_default;
  SELECT id INTO d_mkt_todo FROM public.workflow_state WHERE team_id = d_mkt AND is_default;
  SELECT id INTO s_dsg_todo FROM public.workflow_state WHERE team_id = s_dsg AND is_default;
  INSERT INTO public.workflow_state (team_id, name, category, color, sort_order) VALUES (s_mkt, 'QA', 'started', '#000000', 9) RETURNING id INTO s_mkt_qa;
  INSERT INTO pg_temp.e2e VALUES ('s_mkt_qa', s_mkt_qa);
  INSERT INTO public.team_member (team_id, member_id) VALUES (s_mkt, m2s), (s_mkt, m3s) ON CONFLICT DO NOTHING;
  INSERT INTO public.team_member (team_id, member_id) VALUES (d_mkt, m2d) ON CONFLICT DO NOTHING;

  -- cycles: active on both Marketings
  INSERT INTO public.cycle (team_id, start_date, end_date, status) VALUES (s_mkt, current_date, current_date + 14, 'active') RETURNING id INTO cyc_s;
  INSERT INTO public.cycle (team_id, start_date, end_date, status) VALUES (d_mkt, current_date, current_date + 14, 'active') RETURNING id INTO cyc_d;
  INSERT INTO pg_temp.e2e VALUES ('cyc_s', cyc_s), ('cyc_d', cyc_d);

  -- default projects for u1 in both
  INSERT INTO public.projects (user_id, name, workspace_id) VALUES (u1, '__default__', s) RETURNING id INTO proj_def_s;
  INSERT INTO public.projects (user_id, name, workspace_id) VALUES (u1, '__default__', d) RETURNING id INTO proj_def_d;
  INSERT INTO pg_temp.e2e VALUES ('proj_def_s', proj_def_s), ('proj_def_d', proj_def_d);

  -- actions
  INSERT INTO public.actions (user_id, title, workspace_id, team_id, status_id) VALUES (u1, 'gen one', s, s_gen, s_gen_todo) RETURNING id INTO a1;
  INSERT INTO public.actions (user_id, title, workspace_id, team_id, status_id) VALUES (u1, 'gen two', s, s_gen, s_gen_todo) RETURNING id INTO a2;
  INSERT INTO public.actions (user_id, title, workspace_id, team_id, status_id, project_id) VALUES (u1, 'gen three in default project', s, s_gen, s_gen_todo, proj_def_s) RETURNING id INTO a3;
  INSERT INTO public.actions (user_id, title, workspace_id, team_id, status_id) VALUES (u1, 'imported xyz', s, s_gen, s_gen_todo) RETURNING id INTO a_xyz;
  UPDATE public.actions SET identifier = 'XYZ-5' WHERE id = a_xyz;
  INSERT INTO public.actions (user_id, title, workspace_id, team_id, status_id) VALUES (u1, 'd imported xyz', d, d_gen, d_gen_todo) RETURNING id INTO d_a_xyz;
  UPDATE public.actions SET identifier = 'XYZ-5' WHERE id = d_a_xyz;
  INSERT INTO public.actions (user_id, title, workspace_id, team_id, status_id, cycle_id) VALUES (u1, 'mkt one', s, s_mkt, s_mkt_todo, cyc_s) RETURNING id INTO a_mkt1;
  INSERT INTO public.actions (user_id, title, workspace_id, team_id, status_id) VALUES (u1, 'mkt two', s, s_mkt, s_mkt_todo) RETURNING id INTO a_mkt2;
  INSERT INTO public.actions (user_id, title, workspace_id, team_id, status_id) VALUES (u1, 'mkt qa', s, s_mkt, s_mkt_qa) RETURNING id INTO a_qa;
  INSERT INTO public.actions (user_id, title, workspace_id, team_id, status_id) VALUES (u1, 'd mkt one', d, d_mkt, d_mkt_todo) RETURNING id INTO d_a_mkt1;
  INSERT INTO public.actions (user_id, title, workspace_id, team_id, status_id) VALUES (u1, 'dsg one', s, s_dsg, s_dsg_todo) RETURNING id INTO a_dsg;
  INSERT INTO pg_temp.e2e VALUES ('a1', a1), ('a2', a2), ('a3', a3), ('a_xyz', a_xyz), ('a_mkt1', a_mkt1), ('a_mkt2', a_mkt2), ('a_qa', a_qa), ('a_dsg', a_dsg), ('d_a_xyz', d_a_xyz), ('d_a_mkt1', d_a_mkt1);
  UPDATE public.actions SET assignee_id = m2s WHERE id = a1;           -- dup member → translated
  UPDATE public.actions SET assignee_id = m3s WHERE id = a2;           -- member only in s → re-stamps with them
  INSERT INTO public.action_assignee (action_id, member_id) VALUES (a1, m2s), (a1, m3s);
  INSERT INTO public.comment (body, commentable_type, commentable_id, author_id) VALUES ('by u2', 'action', a1, m2s);
  INSERT INTO public.comment (body, commentable_type, commentable_id, author_id) VALUES ('by u3', 'action', a1, m3s);

  -- labels: Bug/bug collide (case), Design is new
  INSERT INTO public.label (workspace_id, name) VALUES (s, 'Bug') RETURNING id INTO l_bug_s;
  INSERT INTO public.label (workspace_id, name) VALUES (d, 'bug') RETURNING id INTO l_bug_d;
  INSERT INTO public.label (workspace_id, name) VALUES (s, 'Design') RETURNING id INTO l_design_s;
  INSERT INTO public.action_label (action_id, label_id) VALUES (a1, l_bug_s), (a1, l_design_s), (a_mkt1, l_bug_s);
  INSERT INTO pg_temp.e2e VALUES ('l_bug_s', l_bug_s), ('l_bug_d', l_bug_d), ('l_design_s', l_design_s);

  -- contacts and companies
  INSERT INTO public.contact (workspace_id, full_name, email, notes) VALUES (s, 'Shared Person', 'shared-e2e@example.com', 'from s') RETURNING id INTO c1s;
  INSERT INTO public.contact (workspace_id, full_name, email, phone) VALUES (d, 'Shared Person', 'Shared-E2E@example.com', '+1') RETURNING id INTO c1d;
  INSERT INTO public.contact (workspace_id, full_name, email) VALUES (s, 'Only Source', 'only-e2e@example.com') RETURNING id INTO c2s;
  INSERT INTO public.company (workspace_id, name, domain) VALUES (s, 'Acme', 'acme-e2e.com') RETURNING id INTO co_acme_s;
  INSERT INTO public.company (workspace_id, name, domain, website) VALUES (d, 'ACME Inc', 'acme-e2e.com', 'https://acme') RETURNING id INTO co_acme_d;
  INSERT INTO public.company (workspace_id, name, domain, is_workspace_company) VALUES (s, 'Source Co', 'source-co-e2e.com', true) RETURNING id INTO co_ws_s;
  INSERT INTO public.company (workspace_id, name, domain, is_workspace_company) VALUES (d, 'Dest Co', 'dest-co-e2e.com', true) RETURNING id INTO co_ws_d;
  UPDATE public.contact SET company_id = co_acme_s WHERE id = c2s;
  INSERT INTO pg_temp.e2e VALUES ('c1s', c1s), ('c1d', c1d), ('c2s', c2s), ('co_acme_s', co_acme_s), ('co_acme_d', co_acme_d), ('co_ws_s', co_ws_s), ('co_ws_d', co_ws_d);

  -- a capture with the shared contact as participant, a claim with evidence
  INSERT INTO public.captures (user_id, title, workspace_id, team_id, status, ended_at) VALUES (u1, 'standup', s, s_mkt, 'completed', now()) RETURNING id INTO cap_s;
  INSERT INTO public.capture_participant (capture_id, contact_id, external_name) VALUES (cap_s, c1s, 'Shared Person');
  INSERT INTO public.claim (workspace_id, text, type) VALUES (s, 'the e2e claim', 'fact') RETURNING id INTO claim_s;
  INSERT INTO public.claim_source (claim_id, source_type, source_id, workspace_id) VALUES (claim_s, 'capture', cap_s, s);
  INSERT INTO public.entity_link (workspace_id, source_type, source_id, target_type, target_id) VALUES (s, 'claim', claim_s, 'capture', cap_s);
  INSERT INTO public.knowledge_brief (workspace_id, scope_type, content, source_fingerprint) VALUES (s, 'workspace', 'source brief', 'fp-s'), (d, 'workspace', 'dest brief', 'fp-d');
  INSERT INTO pg_temp.e2e VALUES ('cap_s', cap_s), ('claim_s', claim_s);

  -- mail: one google account homed in s, linked to both; thread T1 copied in both, T2 only in s
  INSERT INTO public.connected_account (user_id, workspace_id, provider, capability, account_email) VALUES (u1, s, 'google', 'email', 'merge-e2e-' || left(s::text, 6) || '@example.com') RETURNING id INTO acct;
  INSERT INTO public.connected_account_workspace (account_id, workspace_id) VALUES (acct, s), (acct, d);
  INSERT INTO public.email_thread_index (workspace_id, user_id, provider, provider_thread_id, account_id, is_starred) VALUES (s, u1, 'google', 'T1-e2e', acct, true) RETURNING id INTO t1s;
  INSERT INTO public.email_thread_index (workspace_id, user_id, provider, provider_thread_id, account_id, is_starred) VALUES (d, u1, 'google', 'T1-e2e', acct, false) RETURNING id INTO t1d;
  INSERT INTO public.email_thread_index (workspace_id, user_id, provider, provider_thread_id, account_id, linked_contact_id) VALUES (s, u1, 'google', 'T2-e2e', acct, c1s) RETURNING id INTO t2s;
  INSERT INTO public.email_thread_label (thread_id, label_id) VALUES (t1s, l_bug_s);
  INSERT INTO pg_temp.e2e VALUES ('acct', acct), ('t1s', t1s), ('t1d', t1d), ('t2s', t2s);

  -- integrations: linear on both (destination wins), jira only in s (moves)
  INSERT INTO public.connected_account (user_id, workspace_id, provider, capability, account_email) VALUES (u1, s, 'linear', 'tasks', 'lin-s-' || left(s::text, 6) || '@example.com') RETURNING id INTO acct_lin_s;
  INSERT INTO public.connected_account (user_id, workspace_id, provider, capability, account_email) VALUES (u1, d, 'linear', 'tasks', 'lin-d-' || left(d::text, 6) || '@example.com') RETURNING id INTO acct_lin_d;
  INSERT INTO public.connected_account (user_id, workspace_id, provider, capability, account_email) VALUES (u1, s, 'jira', 'tasks', 'jira-s-' || left(s::text, 6) || '@example.com') RETURNING id INTO acct_jira_s;
  INSERT INTO public.task_sync_state (user_id, workspace_id, provider, account_id) VALUES (u1, s, 'linear', acct_lin_s), (u1, d, 'linear', acct_lin_d), (u1, s, 'jira', acct_jira_s);
  INSERT INTO public.action_external_task (workspace_id, action_id, provider, external_id, external_url, external_title) VALUES (s, a_mkt2, 'linear', 'LIN-1', 'https://linear.app/e2e/LIN-1', 'Linear issue');
  INSERT INTO public.action_external_task (workspace_id, action_id, provider, external_id, external_url, external_title) VALUES (s, a_dsg, 'jira', '10001', 'https://e2e.atlassian.net/browse/E-1', 'Jira issue');

  -- flows: seeded Triage on both; one more in s that names the QA state and the Marketing team
  INSERT INTO public.flow (workspace_id, name, trigger_type, created_by, seed_key) VALUES (s, 'Triage', 'capture_processed', u1, 'seed:triage') RETURNING id INTO f_triage_s;
  INSERT INTO public.flow (workspace_id, name, trigger_type, created_by, seed_key) VALUES (d, 'Triage', 'capture_processed', u1, 'seed:triage') RETURNING id INTO f_triage_d;
  INSERT INTO public.flow_run (flow_id, status) VALUES (f_triage_s, 'success');
  INSERT INTO public.flow (workspace_id, name, trigger_type, created_by, team_id, trigger_config) VALUES (s, 'QA watcher', 'entity_status_change', u1, s_mkt, jsonb_build_object('status_id', s_mkt_qa, 'team_id', s_mkt)) RETURNING id INTO f_other_s;
  INSERT INTO pg_temp.e2e VALUES ('f_triage_s', f_triage_s), ('f_triage_d', f_triage_d), ('f_other_s', f_other_s);

  -- system teammates exist from the workspace trigger; threads with the mail bot on both sides, a home thread on both, a conversation with an eve session
  SELECT id INTO bot_mail_s FROM public.ai_team_member WHERE workspace_id = s AND system_key = 'mail';
  SELECT id INTO bot_mail_d FROM public.ai_team_member WHERE workspace_id = d AND system_key = 'mail';
  INSERT INTO public.chat_conversations (user_id, workspace_id, title, ai_team_member_id) VALUES (u1, s, 'Mail bot', bot_mail_s) RETURNING id INTO conv_bot_s;
  INSERT INTO public.chat_conversations (user_id, workspace_id, title, ai_team_member_id) VALUES (u1, d, 'Mail bot', bot_mail_d) RETURNING id INTO conv_bot_d;
  INSERT INTO public.chat_conversations (user_id, workspace_id, title, is_home) VALUES (u1, s, 'Home', true) RETURNING id INTO conv_home_s;
  INSERT INTO public.chat_conversations (user_id, workspace_id, title, is_home) VALUES (u1, d, 'Home', true) RETURNING id INTO conv_home_d;
  INSERT INTO public.chat_conversations (user_id, workspace_id, title, eve_session_id) VALUES (u1, s, 'with session', 'sess-e2e-' || left(s::text, 8)) RETURNING id INTO conv_eve_s;
  INSERT INTO pg_temp.e2e VALUES ('bot_mail_s', bot_mail_s), ('bot_mail_d', bot_mail_d), ('conv_bot_s', conv_bot_s), ('conv_bot_d', conv_bot_d), ('conv_home_s', conv_home_s), ('conv_home_d', conv_home_d), ('conv_eve_s', conv_eve_s);

  -- documents: canon 'product' on both, slug 'roadmap-e2e' on both
  INSERT INTO public.document (workspace_id, title, canon_key, created_by) VALUES (s, 'Product', 'product', m1s) RETURNING id INTO doc_prod_s;
  INSERT INTO public.document (workspace_id, title, canon_key, created_by) VALUES (d, 'Product', 'product', m1d) RETURNING id INTO doc_prod_d;
  INSERT INTO public.document (workspace_id, title, slug, created_by, team_id) VALUES (s, 'Roadmap', 'roadmap-e2e', m1s, s_mkt) RETURNING id INTO doc_road_s;
  INSERT INTO public.document (workspace_id, title, slug, created_by) VALUES (d, 'Roadmap', 'roadmap-e2e', m1d) RETURNING id INTO doc_road_d;
  INSERT INTO pg_temp.e2e VALUES ('doc_prod_s', doc_prod_s), ('doc_prod_d', doc_prod_d), ('doc_road_s', doc_road_s), ('doc_road_d', doc_road_d);

  -- views: same slug on both; the source one filters on the Marketing team and the Bug label
  INSERT INTO public.view (workspace_id, created_by, name, entity_type, slug, team_id, filters) VALUES (s, u1, 'My view', 'action', 'my-view-e2e', s_mkt, jsonb_build_object('team_id', s_mkt, 'label_ids', jsonb_build_array(l_bug_s))) RETURNING id INTO view_s;
  INSERT INTO public.view (workspace_id, created_by, name, entity_type, slug) VALUES (d, u1, 'My view', 'action', 'my-view-e2e') RETURNING id INTO view_d;
  INSERT INTO pg_temp.e2e VALUES ('view_s', view_s), ('view_d', view_d);

  -- a pending reminder, a device pinned to the source, a skill slug on both
  INSERT INTO public.reminder (workspace_id, user_id, entity_type, entity_id, remind_at) VALUES (s, u1, 'action', a1, now() + interval '1 day');
  INSERT INTO public.device_token (user_id, name, token_hash, token_prefix, active_workspace_id) VALUES (u1, 'e2e device', 'e2e-hash-' || s::text, 'e2e', s);
  INSERT INTO public.recipe (name, system_prompt, workspace_id, slug, category) VALUES ('My skill', 'do', s, 'my-skill-e2e', 'skill'), ('My skill', 'do', d, 'my-skill-e2e', 'skill');

  -- 408 cases: active enrollments on a folded contact (no collision in d) and on a source-only contact;
  -- a third folded contact whose person d is already sequencing (the source enrollment ends, counted);
  -- the source Bug label is action-only while d's is universal
  INSERT INTO public.contact (workspace_id, full_name, email) VALUES (s, 'Twin', 'twin-e2e@example.com') RETURNING id INTO c3s;
  INSERT INTO public.contact (workspace_id, full_name, email) VALUES (d, 'Twin', 'twin-e2e@example.com') RETURNING id INTO c3d;
  INSERT INTO public.sequence (workspace_id, name, status, created_by) VALUES (s, 'Seq E2E', 'active', u1) RETURNING id INTO seq_s;
  INSERT INTO public.sequence (workspace_id, name, status, created_by) VALUES (d, 'Seq E2E dest', 'active', u1) RETURNING id INTO seq_d;
  INSERT INTO public.sequence_enrollment (workspace_id, sequence_id, contact_id, contact_email, status) VALUES (s, seq_s, c1s, 'shared-e2e@example.com', 'active') RETURNING id INTO enr_s;
  INSERT INTO public.sequence_enrollment (workspace_id, sequence_id, contact_id, contact_email, status) VALUES (s, seq_s, c2s, 'only-e2e@example.com', 'active') RETURNING id INTO enr_s2;
  INSERT INTO public.sequence_enrollment (workspace_id, sequence_id, contact_id, contact_email, status) VALUES (s, seq_s, c3s, 'twin-e2e@example.com', 'active') RETURNING id INTO enr_s3;
  INSERT INTO public.sequence_enrollment (workspace_id, sequence_id, contact_id, contact_email, status) VALUES (d, seq_d, c3d, 'twin-e2e@example.com', 'active') RETURNING id INTO enr_d3;
  UPDATE public.label SET scopes = ARRAY['action'] WHERE id = l_bug_s;
  INSERT INTO pg_temp.e2e VALUES ('seq_s', seq_s), ('enr_s', enr_s), ('enr_s2', enr_s2), ('c3s', c3s), ('c3d', c3d), ('enr_s3', enr_s3), ('enr_d3', enr_d3);

  -- 417 cases: what is not running does not make the source busy, and comes over — a capture quiet for two
  -- days that never ended, a coding run parked in pr_open, a run waiting for an answer, a job waiting for review
  INSERT INTO public.captures (user_id, title, workspace_id, status, started_at, updated_at)
  VALUES (u1, 'stale', s, 'active', now() - interval '2 days', now() - interval '2 days') RETURNING id INTO cap_stale;
  INSERT INTO public.agent_run (workspace_id, action_id, status) VALUES (s, a_dsg, 'pr_open') RETURNING id INTO run_pr;
  INSERT INTO public.agent_run (workspace_id, action_id, status) VALUES (s, a_dsg, 'needs_input') RETURNING id INTO run_wait;
  INSERT INTO public.tracked_job (workspace_id, kind, title, member_id, status) VALUES (s, 'agent_run', 'review me', m1s, 'needs_review') RETURNING id INTO job_review;
  INSERT INTO pg_temp.e2e VALUES ('cap_stale', cap_stale), ('run_pr', run_pr), ('run_wait', run_wait), ('job_review', job_review);
END $$;

-- ---------- 707: what has been added since 528 ----------
-- Company stages (679: both workspaces have the defaults), a person's
-- company and email consent, team chat (a direct message between the same two
-- people in both, a direct message with someone only in the source, a channel
-- named like one in the destination), their reactions, threads and calls'
-- rows, shares, spreadsheets, canvases, the drive, vocabulary, a day's
-- auto-archive, a private thread, booking pages, a grant to the folding team.
DO $$
DECLARE
  s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 's'); d uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'd');
  u1 uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'u1'); u2 uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'u2');
  m1s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'm1s'); m1d uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'm1d');
  m2s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'm2s'); m2d uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'm2d');
  m3s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'm3s');
  co_acme_s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'co_acme_s'); co_acme_d uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'co_acme_d');
  t1s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 't1s'); t1d uuid := (SELECT v FROM pg_temp.e2e WHERE k = 't1d');
  s_mkt uuid := (SELECT v FROM pg_temp.e2e WHERE k = 's_mkt');
  st_lead_s uuid; st_demo_s uuid; st_pilot_s uuid; st_lead_d uuid; st_demo_d uuid;
  co_only uuid; co_pilot uuid; view_st uuid;
  dm_s uuid; dm_d uuid; dm3_s uuid; ch_s uuid; ch_d uuid; ch_mkt uuid; msg_s uuid; msg_d uuid;
  sheet uuid; cnv uuid; fold uuid; conv uuid; doc uuid;
  bp_s uuid; bp_d uuid; bl_s uuid;
BEGIN
  -- stages: the seeded defaults on both, and one the source added
  SELECT id INTO st_lead_s FROM public.company_stage WHERE workspace_id = s AND name = 'Lead';
  SELECT id INTO st_demo_s FROM public.company_stage WHERE workspace_id = s AND name = 'Demo';
  SELECT id INTO st_lead_d FROM public.company_stage WHERE workspace_id = d AND name = 'Lead';
  SELECT id INTO st_demo_d FROM public.company_stage WHERE workspace_id = d AND name = 'Demo';
  IF st_lead_s IS NULL OR st_lead_d IS NULL THEN RAISE EXCEPTION 'E2E SETUP: the default company stages were not seeded'; END IF;
  INSERT INTO public.company_stage (workspace_id, name, position) VALUES (s, 'Pilot', 9) RETURNING id INTO st_pilot_s;
  -- Acme folds into ACME Inc (no stage, no owner): it takes the source's
  UPDATE public.company SET stage_id = st_lead_s, owner_member_id = m3s WHERE id = co_acme_s;
  INSERT INTO public.company (workspace_id, name, domain, stage_id, owner_member_id) VALUES (s, 'Only Co', 'only-co-e2e.com', st_demo_s, m2s) RETURNING id INTO co_only;
  INSERT INTO public.company (workspace_id, name, domain, stage_id) VALUES (s, 'Pilot Co', 'pilot-co-e2e.com', st_pilot_s) RETURNING id INTO co_pilot;
  INSERT INTO public.view (workspace_id, created_by, name, entity_type, slug, filters)
  VALUES (s, u1, 'Demos', 'company', 'demos-e2e', jsonb_build_object('stage_id', jsonb_build_array(st_demo_s))) RETURNING id INTO view_st;
  INSERT INTO public.comment (body, commentable_type, commentable_id, author_id) VALUES ('on acme', 'company', co_acme_s, m2s);
  INSERT INTO public.company_email_consent (workspace_id, company_id, user_id) VALUES (s, co_acme_s, u1), (d, co_acme_d, u1);
  UPDATE public.company SET share_email_changed_by_member_id = m2s WHERE id = co_only;
  INSERT INTO pg_temp.e2e VALUES ('st_lead_s', st_lead_s), ('st_demo_s', st_demo_s), ('st_pilot_s', st_pilot_s), ('st_lead_d', st_lead_d), ('st_demo_d', st_demo_d),
    ('co_only', co_only), ('co_pilot', co_pilot), ('view_st', view_st);

  -- team chat
  INSERT INTO public.team_chat_channel (workspace_id, kind, dm_key, created_by)
  VALUES (s, 'dm', CASE WHEN m1s::text < m2s::text THEN m1s::text || ':' || m2s::text ELSE m2s::text || ':' || m1s::text END, m1s) RETURNING id INTO dm_s;
  INSERT INTO public.team_chat_channel (workspace_id, kind, dm_key, created_by)
  VALUES (d, 'dm', CASE WHEN m1d::text < m2d::text THEN m1d::text || ':' || m2d::text ELSE m2d::text || ':' || m1d::text END, m1d) RETURNING id INTO dm_d;
  INSERT INTO public.team_chat_channel (workspace_id, kind, dm_key, created_by)
  VALUES (s, 'dm', CASE WHEN m1s::text < m3s::text THEN m1s::text || ':' || m3s::text ELSE m3s::text || ':' || m1s::text END, m3s) RETURNING id INTO dm3_s;
  INSERT INTO public.team_chat_channel (workspace_id, kind, name, created_by) VALUES (s, 'channel', 'General', m2s) RETURNING id INTO ch_s;
  INSERT INTO public.team_chat_channel (workspace_id, kind, name, created_by) VALUES (d, 'channel', 'general', m1d) RETURNING id INTO ch_d;
  INSERT INTO public.team_chat_channel (workspace_id, team_id, kind, name, created_by) VALUES (s, s_mkt, 'channel', 'Campaigns', m2s) RETURNING id INTO ch_mkt;
  INSERT INTO public.team_chat_member (channel_id, member_id, workspace_id, last_read_at) VALUES
    (dm_s, m1s, s, now()), (dm_s, m2s, s, now() - interval '1 hour'), (dm_d, m1d, d, now() - interval '2 hours'), (dm_d, m2d, d, now() - interval '1 day'),
    (dm3_s, m1s, s, now()), (dm3_s, m3s, s, now()), (ch_s, m2s, s, now()), (ch_d, m2d, d, now());
  INSERT INTO public.team_chat_message (channel_id, workspace_id, author_kind, author_member_id, body) VALUES (dm_s, s, 'member', m2s, 'hi from s') RETURNING id INTO msg_s;
  INSERT INTO public.team_chat_message (channel_id, workspace_id, author_kind, author_member_id, body) VALUES (dm_d, d, 'member', m2d, 'hi from d') RETURNING id INTO msg_d;
  INSERT INTO public.team_chat_message (channel_id, workspace_id, author_kind, author_member_id, body) VALUES (ch_s, s, 'member', m2s, 'in general');
  INSERT INTO public.team_chat_reaction (message_id, member_id, emoji, channel_id, workspace_id) VALUES (msg_s, m2s, ':+1:', dm_s, s), (msg_s, m1s, ':+1:', dm_s, s);
  INSERT INTO public.team_chat_thread_member (root_id, member_id, channel_id, workspace_id, last_read_at) VALUES (msg_s, m2s, dm_s, s, now());
  INSERT INTO pg_temp.e2e VALUES ('dm_s', dm_s), ('dm_d', dm_d), ('dm3_s', dm3_s), ('ch_s', ch_s), ('ch_d', ch_d), ('ch_mkt', ch_mkt), ('msg_s', msg_s), ('msg_d', msg_d);

  -- what a member made or was given
  INSERT INTO public.spreadsheet (workspace_id, created_by, last_edited_by) VALUES (s, m2s, m2s) RETURNING id INTO sheet;
  INSERT INTO public.canvas (workspace_id, owner_member_id) VALUES (s, m2s) RETURNING id INTO cnv;
  INSERT INTO public.drive_folder (workspace_id, name, created_by) VALUES (s, 'Shared e2e', m2s) RETURNING id INTO fold;
  SELECT id INTO conv FROM public.chat_conversations WHERE workspace_id = s ORDER BY created_at LIMIT 1;
  INSERT INTO public.conversation_share (workspace_id, conversation_id, shared_by, grantee_member_id) VALUES (s, conv, u1, m2s);
  INSERT INTO public.email_thread_share (workspace_id, owner_user_id, provider, provider_thread_id, message_ids, grantee_member_id, thread_index_id)
  VALUES (s, u1, 'google', 'T1-e2e', '{m-e2e-1}', m2s, t1s), (d, u1, 'google', 'T1-e2e', '{m-e2e-1}', m2d, t1d);
  INSERT INTO pg_temp.e2e VALUES ('sheet', sheet), ('cnv', cnv), ('fold', fold), ('conv', conv);

  -- one per person: a word, a day's auto-archive, a private thread, a booking profile with a taken slug
  INSERT INTO public.vocabulary_term (workspace_id, user_id, term) VALUES (s, u1, 'Coherix'), (d, u1, 'coherix '), (s, u1, 'Only source word');
  INSERT INTO public.email_auto_archive (workspace_id, user_id, local_date, cutoff_at, thread_ids) VALUES
    (s, u1, current_date, now(), ARRAY['th-s']), (d, u1, current_date, now(), ARRAY['th-d']);
  INSERT INTO public.email_thread_team_private (workspace_id, owner_user_id, provider_thread_id, thread_index_id) VALUES (s, u1, 'T1-e2e', t1s), (d, u1, 'T1-e2e', t1d);
  INSERT INTO public.booking_profile (workspace_id, user_id, handle) VALUES (s, u1, 'u1-s-' || left(s::text, 8)) RETURNING id INTO bp_s;
  INSERT INTO public.booking_profile (workspace_id, user_id, handle) VALUES (d, u1, 'u1-d-' || left(d::text, 8)) RETURNING id INTO bp_d;
  INSERT INTO public.booking_link (workspace_id, owner_user_id, profile_id, slug, title) VALUES (s, u1, bp_s, 'intro', 'Intro (s)') RETURNING id INTO bl_s;
  INSERT INTO public.booking_link (workspace_id, owner_user_id, profile_id, slug, title) VALUES (d, u1, bp_d, 'intro', 'Intro (d)');
  INSERT INTO pg_temp.e2e VALUES ('bp_s', bp_s), ('bp_d', bp_d), ('bl_s', bl_s);

  -- a grant to the Marketing team, which folds
  SELECT id INTO doc FROM public.document WHERE workspace_id = s ORDER BY created_at LIMIT 1;
  INSERT INTO public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_team_id, level)
  VALUES (s, 'document', doc, 'team', s_mkt, 'view');
  INSERT INTO pg_temp.e2e VALUES ('doc_grant', doc);
END $$;

-- ---------- 707: the batch merged after 705 ----------
-- Snippets (699): a shared shortcut with the same text in both (folds), one
-- with other text (takes -2), a personal shortcut of a person in both (takes
-- -2), one only in the source (moves, maker re-pointed). A closed poll (703)
-- a folded member made and voted in, an import (704) by that member, the same
-- hold (702) in both, the same outside CRM record (462) in both, the same
-- GitHub repository (694) in both, a booking link with a form (705).
DO $$
DECLARE
  s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 's'); d uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'd');
  u1 uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'u1'); u2 uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'u2');
  m2s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'm2s'); m2d uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'm2d');
  ch_s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'ch_s');
  c2s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'c2s'); c1d uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'c1d');
  sn_same uuid; sn_other uuid; sn_mine uuid; sn_only uuid; msg uuid; poll uuid; opt uuid; imp uuid; tbl uuid; frm uuid; bl uuid;
BEGIN
  INSERT INTO public.snippet (workspace_id, created_by, name, shortcut, body, visibility) VALUES (s, m2s, 'Thanks', 'thanks', 'Thank you!', 'workspace') RETURNING id INTO sn_same;
  INSERT INTO public.snippet (workspace_id, created_by, name, shortcut, body, visibility) VALUES (d, m2d, 'Thanks', 'thanks', 'Thank you!', 'workspace');
  INSERT INTO public.snippet (workspace_id, created_by, name, shortcut, body, visibility) VALUES (s, m2s, 'Hours', 'hours', 'We open at 9.', 'workspace') RETURNING id INTO sn_other;
  INSERT INTO public.snippet (workspace_id, created_by, name, shortcut, body, visibility) VALUES (d, m2d, 'Hours', 'hours', 'We open at 8.', 'workspace');
  INSERT INTO public.snippet (workspace_id, created_by, name, shortcut, body, visibility) VALUES (s, m2s, 'Sign-off', 'sig', 'U2 (s)', 'personal') RETURNING id INTO sn_mine;
  INSERT INTO public.snippet (workspace_id, created_by, name, shortcut, body, visibility) VALUES (d, m2d, 'Sign-off', 'sig', 'U2 (d)', 'personal');
  INSERT INTO public.snippet (workspace_id, created_by, name, shortcut, body, visibility) VALUES (s, m2s, 'Only here', 'only', 'Only in s', 'personal') RETURNING id INTO sn_only;

  INSERT INTO public.team_chat_message (channel_id, workspace_id, author_kind, author_member_id, body) VALUES (ch_s, s, 'member', m2s, 'Lunch?') RETURNING id INTO msg;
  INSERT INTO public.team_chat_poll (workspace_id, channel_id, message_id, question, created_by) VALUES (s, ch_s, msg, 'Lunch?', m2s) RETURNING id INTO poll;
  INSERT INTO public.team_chat_poll_option (poll_id, position, label) VALUES (poll, 0, 'Yes') RETURNING id INTO opt;
  INSERT INTO public.team_chat_poll_vote (poll_id, option_id, member_id, workspace_id) VALUES (poll, opt, m2s, s);
  UPDATE public.team_chat_poll SET closed_at = now(), closed_by = m2s WHERE id = poll;

  INSERT INTO public.work_import (workspace_id, user_id, member_id, source) VALUES (s, u2, m2s, 'task_csv') RETURNING id INTO imp;
  INSERT INTO public.inbox_hold (user_id, workspace_id, item_key, held_until) VALUES (u1, s, 'mail:T1-e2e', now() + interval '3 days'), (u1, d, 'mail:T1-e2e', now() + interval '1 day');
  INSERT INTO public.crm_source_link (workspace_id, source, kind, external_id, entity_id) VALUES (s, 'hubspot', 'contact', 'hs-e2e-1', c2s), (d, 'hubspot', 'contact', 'hs-e2e-1', c1d);
  INSERT INTO public.workspace_github_repo (workspace_id, repo_full_name, added_by) VALUES (s, 'example/e2e-repo', u1), (d, 'example/e2e-repo', u1);

  INSERT INTO public.data_table (workspace_id, name) VALUES (s, 'Intake e2e') RETURNING id INTO tbl;
  INSERT INTO public.data_form (workspace_id, table_id, name, key_hash, key_prefix) VALUES (s, tbl, 'Intake', 'e2e-hash-' || s::text, 'e2e') RETURNING id INTO frm;
  INSERT INTO public.booking_link (workspace_id, owner_user_id, slug, title, form_id) VALUES (s, u1, 'intake-e2e', 'Intake', frm) RETURNING id INTO bl;

  INSERT INTO pg_temp.e2e VALUES ('sn_same', sn_same), ('sn_other', sn_other), ('sn_mine', sn_mine), ('sn_only', sn_only), ('poll', poll),
    ('imp', imp), ('frm', frm), ('bl_form', bl);
END $$;

-- ---------- refusals ----------
DO $$
DECLARE s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 's'); d uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'd');
        u1 uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'u1'); u2 uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'u2');
        out jsonb := '{}'::jsonb; cap uuid; run uuid; z uuid; d_a uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'd_a_mkt1'); s_gen uuid := (SELECT v FROM pg_temp.e2e WHERE k = 's_gen');
BEGIN
  BEGIN PERFORM public.merge_workspace(s, d, u2); out := out || '{"not_owner":"NO ERROR"}';
  EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('not_owner', SQLSTATE); END;
  BEGIN PERFORM public.merge_workspace(s, d, gen_random_uuid()); out := out || '{"stranger":"NO ERROR"}';
  EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('stranger', SQLSTATE); END;
  BEGIN PERFORM public.merge_workspace(s, s, u1); out := out || '{"same":"NO ERROR"}';
  EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('same', SQLSTATE); END;
  BEGIN PERFORM public.merge_workspace(s, d, u1, jsonb_build_object('teams', jsonb_build_array(jsonb_build_object('source_team_id', s_gen, 'mode', 'fold')))); out := out || '{"bad_plan":"NO ERROR"}';
  EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('bad_plan', SQLSTATE); END;
  -- busy: a live capture in the source
  INSERT INTO public.captures (user_id, title, workspace_id, status, started_at) VALUES (u1, 'live', s, 'active', now()) RETURNING id INTO cap;
  BEGIN PERFORM public.merge_workspace(s, d, u1); out := out || '{"busy":"NO ERROR"}';
  EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('busy', SQLSTATE); END;
  UPDATE public.captures SET ended_at = now(), status = 'completed' WHERE id = cap;
  -- busy: an agent run executing in the source still refuses (417)
  INSERT INTO public.agent_run (workspace_id, action_id, status) VALUES (s, (SELECT v FROM pg_temp.e2e WHERE k = 'a_dsg'), 'running') RETURNING id INTO run;
  BEGIN PERFORM public.merge_workspace(s, d, u1); out := out || '{"busy_run":"NO ERROR"}';
  EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('busy_run', SQLSTATE); END;
  UPDATE public.agent_run SET status = 'completed' WHERE id = run;
  -- drift: a destination action on a team of another workspace
  UPDATE public.actions SET team_id = s_gen WHERE id = d_a;
  BEGIN PERFORM public.merge_workspace(s, d, u1); out := out || '{"drift":"NO ERROR"}';
  EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('drift', SQLSTATE || ' ' || left(SQLERRM, 80)); END;
  UPDATE public.actions SET team_id = (SELECT v FROM pg_temp.e2e WHERE k = 'd_mkt') WHERE id = d_a;
  -- the 408 guard: the source Bug label is still on two actions and a thread copy, so deleting it is refused,
  -- naming each column; with those junctions excepted (a step that deletes them on purpose) it passes
  BEGIN PERFORM public._wsmerge_assert_no_refs('label', ARRAY[(SELECT v FROM pg_temp.e2e WHERE k = 'l_bug_s')], '{}'); out := out || '{"guard":"NO ERROR"}';
  EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('guard', SQLSTATE || ' ' || SQLERRM); END;
  BEGIN PERFORM public._wsmerge_assert_no_refs('label', ARRAY[(SELECT v FROM pg_temp.e2e WHERE k = 'l_bug_s')], ARRAY['action_label', 'email_thread_label']); out := out || '{"guard_except":"ok"}';
  EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('guard_except', SQLSTATE || ' ' || SQLERRM); END;
  -- 707: what the merge cannot settle on its own (a business phone number on both sides) refuses, naming it
  INSERT INTO public.business_phone_number (workspace_id, owner_user_id, phone_e164) VALUES (s, u1, '+15550100701'), (d, u1, '+15550100702');
  BEGIN PERFORM public.merge_workspace(s, d, u1); out := out || '{"front_door":"NO ERROR"}';
  EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('front_door', SQLSTATE || ' ' || SQLERRM); END;
  DELETE FROM public.business_phone_number WHERE workspace_id IN (s, d);
  -- 707: a business profile on both sides, and a demo workspace, refuse too
  INSERT INTO public.business_profile (workspace_id, owner_user_id, business_name) VALUES (s, u1, 'Source Co'), (d, u1, 'Dest Co');
  BEGIN PERFORM public.merge_workspace(s, d, u1); out := out || '{"business_profile":"NO ERROR"}';
  EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('business_profile', SQLSTATE || ' ' || SQLERRM); END;
  DELETE FROM public.business_profile WHERE workspace_id IN (s, d);
  -- (a clean third workspace: a demo flag refuses one with anything real connected, as both fixtures have)
  INSERT INTO public.workspace (name, slug) VALUES ('Demo E2E', 'demo-e2e-' || left(gen_random_uuid()::text, 8)) RETURNING id INTO z;
  INSERT INTO public.member (user_id, workspace_id, role, display_name) VALUES (u1, z, 'owner', 'U1');
  INSERT INTO public.demo_workspace (workspace_id) VALUES (z);
  BEGIN PERFORM public.merge_workspace(z, d, u1); out := out || '{"demo":"NO ERROR"}';
  EXCEPTION WHEN OTHERS THEN out := out || jsonb_build_object('demo', SQLSTATE || ' ' || SQLERRM); END;
  DELETE FROM public.workspace WHERE id = z;
  INSERT INTO pg_temp.e2e_out VALUES ('refusals', out);
END $$;

-- ---------- preflight, then the merge (Marketing folds, the rest stay their own) ----------
DO $$
DECLARE s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 's'); d uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'd');
        u1 uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'u1'); pre jsonb; plan jsonb; teams jsonb := '[]'::jsonb; t jsonb; res jsonb;
BEGIN
  pre := public.merge_workspace_preflight(s, d, u1);
  INSERT INTO pg_temp.e2e_out VALUES ('preflight', pre);
  FOR t IN SELECT value FROM jsonb_array_elements(pre->'plan'->'teams') LOOP
    IF t->>'source_slug' = 'marketing' THEN
      t := t || jsonb_build_object('mode', 'fold', 'destination_team_id', (SELECT v FROM pg_temp.e2e WHERE k = 'd_mkt'));
    END IF;
    teams := teams || t;
  END LOOP;
  plan := jsonb_build_object('teams', teams, 'snapshot', jsonb_build_object('bucket', 'workspace-merges', 'pages', 3));
  -- A merge that errors is the verdict (707), not an aborted script: its
  -- step and message come back as E2E FAILED.
  BEGIN
    res := public.merge_workspace(s, d, u1, plan);
    INSERT INTO pg_temp.e2e_out VALUES ('merge', res);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO pg_temp.e2e_out VALUES ('merge_error', jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM));
  END;
END $$;

-- ---------- assertions ----------
DO $$
DECLARE
  s uuid := (SELECT v FROM pg_temp.e2e WHERE k = 's'); d uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'd');
  u1 uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'u1'); u2 uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'u2'); u3 uuid := (SELECT v FROM pg_temp.e2e WHERE k = 'u3');
  fails text := ''; n int; txt text; ok boolean; id1 uuid; id2 uuid; v_j jsonb; new_prefix text;
  res jsonb := (SELECT j FROM pg_temp.e2e_out WHERE k = 'merge');
  pre jsonb := (SELECT j FROM pg_temp.e2e_out WHERE k = 'preflight');
  refusals jsonb := (SELECT j FROM pg_temp.e2e_out WHERE k = 'refusals');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.e2e_out WHERE k = 'merge_error') THEN
    RAISE EXCEPTION USING MESSAGE = 'E2E FAILED: the merge raised ' || (SELECT j->>'sqlstate' || ' ' || (j->>'message') FROM pg_temp.e2e_out WHERE k = 'merge_error');
  END IF;

  -- refusals
  IF refusals->>'not_owner' <> '42501' THEN fails := fails || ' not_owner=' || (refusals->>'not_owner'); END IF;
  IF refusals->>'stranger' <> 'P0002' THEN fails := fails || ' stranger=' || (refusals->>'stranger'); END IF;
  IF refusals->>'same' <> '22023' THEN fails := fails || ' same=' || (refusals->>'same'); END IF;
  IF refusals->>'bad_plan' <> 'P0006' THEN fails := fails || ' bad_plan=' || (refusals->>'bad_plan'); END IF;
  IF refusals->>'busy' <> 'P0007' THEN fails := fails || ' busy=' || (refusals->>'busy'); END IF;
  IF left(refusals->>'drift', 5) <> 'P0009' THEN fails := fails || ' drift=' || (refusals->>'drift'); END IF;
  IF refusals->>'busy_run' <> 'P0007' THEN fails := fails || ' busy_run=' || (refusals->>'busy_run'); END IF;
  IF left(refusals->>'guard', 5) <> 'P0008' OR refusals->>'guard' NOT LIKE '%action_label.label_id=2%' OR refusals->>'guard' NOT LIKE '%email_thread_label.label_id=1%'
    THEN fails := fails || ' guard=' || (refusals->>'guard'); END IF;
  IF refusals->>'guard_except' <> 'ok' THEN fails := fails || ' guard_except=' || (refusals->>'guard_except'); END IF;
  IF (pre->>'ok')::boolean IS NOT TRUE THEN fails := fails || ' preflight_not_ok=' || (pre->'blockers')::text; END IF;

  -- the source is gone, the record exists
  IF EXISTS (SELECT 1 FROM public.workspace WHERE id = s) THEN fails := fails || ' source_still_exists'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_merge WHERE source_workspace_id = s AND destination_workspace_id = d AND actor_user_id = u1) THEN fails := fails || ' no_merge_record'; END IF;

  -- people
  SELECT count(*) INTO n FROM public.member WHERE workspace_id = d; IF n <> 3 THEN fails := fails || ' members=' || n; END IF;
  SELECT role INTO txt FROM public.member WHERE workspace_id = d AND user_id = u2; IF txt <> 'admin' THEN fails := fails || ' u2_role=' || txt; END IF;
  SELECT role INTO txt FROM public.member WHERE workspace_id = d AND user_id = u3; IF txt <> 'member' THEN fails := fails || ' u3_role=' || COALESCE(txt, 'missing'); END IF;
  SELECT role INTO txt FROM public.member WHERE workspace_id = d AND user_id = u1; IF txt <> 'owner' THEN fails := fails || ' u1_role=' || txt; END IF;
  SELECT count(*) INTO n FROM public.comment WHERE commentable_id = (SELECT v FROM pg_temp.e2e WHERE k = 'a1') AND author_id = (SELECT v FROM pg_temp.e2e WHERE k = 'm2d'); IF n <> 1 THEN fails := fails || ' u2_comment_translated=' || n; END IF;
  SELECT count(*) INTO n FROM public.comment WHERE commentable_id = (SELECT v FROM pg_temp.e2e WHERE k = 'a1') AND author_id = (SELECT v FROM pg_temp.e2e WHERE k = 'm3s'); IF n <> 1 THEN fails := fails || ' u3_comment_kept=' || n; END IF;
  SELECT assignee_id INTO id1 FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a1'); IF id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'm2d') THEN fails := fails || ' a1_assignee_not_translated'; END IF;
  SELECT count(*) INTO n FROM public.action_assignee WHERE action_id = (SELECT v FROM pg_temp.e2e WHERE k = 'a1'); IF n <> 2 THEN fails := fails || ' a1_assignees=' || n; END IF;
  SELECT count(*) INTO n FROM public.invite WHERE workspace_id = d AND email = 'invitee-e2e@example.com'; IF n <> 1 THEN fails := fails || ' invite_moved=' || n; END IF;

  -- teams
  SELECT count(*) INTO n FROM public.team WHERE workspace_id = d; IF n <> 4 THEN fails := fails || ' teams=' || n; END IF;
  IF EXISTS (SELECT 1 FROM public.team WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 's_mkt')) THEN fails := fails || ' s_marketing_not_deleted'; END IF;
  SELECT issue_prefix, name INTO new_prefix, txt FROM public.team WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 's_gen');
  IF txt <> 'Coherix E2E' THEN fails := fails || ' s_general_name=' || COALESCE(txt, 'missing'); END IF;
  IF new_prefix = 'GEN' THEN fails := fails || ' s_general_prefix_still_GEN'; END IF;
  SELECT issue_prefix INTO txt FROM public.team WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 's_dsg'); IF txt <> 'DSG' THEN fails := fails || ' dsg_prefix=' || COALESCE(txt, 'missing'); END IF;

  -- identifiers
  SELECT identifier INTO txt FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a1');
  IF txt <> new_prefix || '-1' THEN fails := fails || ' a1_identifier=' || txt; END IF;
  SELECT previous_identifier INTO txt FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a1'); IF txt <> 'GEN-1' THEN fails := fails || ' a1_previous=' || COALESCE(txt, 'null'); END IF;
  SELECT identifier INTO txt FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a_xyz');
  IF txt NOT LIKE new_prefix || '-%' OR txt = 'XYZ-5' THEN fails := fails || ' a_xyz_identifier=' || txt; END IF;
  SELECT previous_identifier INTO txt FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a_xyz'); IF txt <> 'XYZ-5' THEN fails := fails || ' a_xyz_previous=' || COALESCE(txt, 'null'); END IF;
  SELECT identifier INTO txt FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'd_a_xyz'); IF txt <> 'XYZ-5' THEN fails := fails || ' d_xyz_changed=' || txt; END IF;
  SELECT identifier INTO txt FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a_mkt2'); IF txt <> 'MKT-2' THEN fails := fails || ' mkt2_identifier=' || txt; END IF;
  SELECT identifier INTO txt FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a_mkt1');
  IF txt = 'MKT-1' OR txt NOT LIKE 'MKT-%' THEN fails := fails || ' mkt1_identifier=' || txt; END IF;
  SELECT previous_identifier INTO txt FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a_mkt1'); IF txt <> 'MKT-1' THEN fails := fails || ' mkt1_previous=' || COALESCE(txt, 'null'); END IF;
  SELECT identifier INTO txt FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a_dsg'); IF txt <> 'DSG-1' THEN fails := fails || ' dsg_identifier=' || txt; END IF;
  SELECT count(*) INTO n FROM public.actions WHERE workspace_id = d; IF n <> 10 THEN fails := fails || ' actions_in_d=' || n; END IF;
  SELECT count(*) INTO n FROM (SELECT identifier FROM public.actions WHERE workspace_id = d GROUP BY identifier HAVING count(*) > 1) x; IF n <> 0 THEN fails := fails || ' duplicate_identifiers=' || n; END IF;
  -- the counter stays ahead
  SELECT count(*) INTO n FROM public.team t WHERE t.workspace_id = d AND t.issue_counter < COALESCE((SELECT max(substring(a.identifier FROM length(t.issue_prefix) + 2)::int) FROM public.actions a WHERE a.workspace_id = d AND left(a.identifier, length(t.issue_prefix) + 1) = t.issue_prefix || '-' AND substring(a.identifier FROM length(t.issue_prefix) + 2) ~ '^[0-9]+$'), 0);
  IF n <> 0 THEN fails := fails || ' counters_behind=' || n; END IF;

  -- fold: team, status ladder, cycle
  SELECT team_id INTO id1 FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a_qa'); IF id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'd_mkt') THEN fails := fails || ' qa_team_not_folded'; END IF;
  SELECT ws.name INTO txt FROM public.actions a JOIN public.workflow_state ws ON ws.id = a.status_id WHERE a.id = (SELECT v FROM pg_temp.e2e WHERE k = 'a_qa'); IF txt <> 'In Progress' THEN fails := fails || ' qa_status=' || txt; END IF;
  SELECT status::text, team_id INTO txt, id1 FROM public.cycle WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'cyc_s'); IF txt <> 'upcoming' OR id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'd_mkt') THEN fails := fails || ' cycle=' || COALESCE(txt, 'missing'); END IF;
  SELECT cycle_id INTO id1 FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a_mkt1'); IF id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'cyc_s') THEN fails := fails || ' mkt1_lost_cycle'; END IF;
  SELECT count(*) INTO n FROM public.team_member WHERE team_id = (SELECT v FROM pg_temp.e2e WHERE k = 'd_mkt'); IF n <> 2 THEN fails := fails || ' d_mkt_members=' || n; END IF;

  -- labels
  IF EXISTS (SELECT 1 FROM public.label WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'l_bug_s')) THEN fails := fails || ' bug_label_not_folded'; END IF;
  SELECT workspace_id INTO id1 FROM public.label WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'l_design_s'); IF id1 <> d THEN fails := fails || ' design_label_not_moved'; END IF;
  SELECT count(*) INTO n FROM public.action_label WHERE action_id = (SELECT v FROM pg_temp.e2e WHERE k = 'a1') AND label_id = (SELECT v FROM pg_temp.e2e WHERE k = 'l_bug_d'); IF n <> 1 THEN fails := fails || ' a1_bug_remap=' || n; END IF;
  SELECT count(*) INTO n FROM public.action_label WHERE action_id = (SELECT v FROM pg_temp.e2e WHERE k = 'a1'); IF n <> 2 THEN fails := fails || ' a1_labels=' || n; END IF;

  -- contacts and companies
  SELECT merged_into_contact_id, workspace_id INTO id1, id2 FROM public.contact WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'c1s');
  IF id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'c1d') OR id2 <> d THEN fails := fails || ' c1_not_folded'; END IF;
  SELECT notes INTO txt FROM public.contact WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'c1d'); IF txt <> 'from s' THEN fails := fails || ' c1_notes_not_coalesced=' || COALESCE(txt, 'null'); END IF;
  SELECT contact_id INTO id1 FROM public.capture_participant WHERE capture_id = (SELECT v FROM pg_temp.e2e WHERE k = 'cap_s'); IF id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'c1d') THEN fails := fails || ' participant_not_repointed'; END IF;
  SELECT count(*) INTO n FROM public.contact_merge WHERE source_contact_id = (SELECT v FROM pg_temp.e2e WHERE k = 'c1s') AND workspace_id = d; IF n <> 1 THEN fails := fails || ' contact_merge_log=' || n; END IF;
  SELECT workspace_id, company_id INTO id1, id2 FROM public.contact WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'c2s'); IF id1 <> d OR id2 <> (SELECT v FROM pg_temp.e2e WHERE k = 'co_acme_d') THEN fails := fails || ' c2_company_not_folded'; END IF;
  IF EXISTS (SELECT 1 FROM public.company WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'co_acme_s')) THEN fails := fails || ' acme_s_not_deleted'; END IF;
  SELECT is_workspace_company, workspace_id INTO ok, id1 FROM public.company WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'co_ws_s'); IF ok OR id1 <> d THEN fails := fails || ' source_co_not_demoted'; END IF;
  SELECT count(*) INTO n FROM public.company WHERE workspace_id = d AND is_workspace_company; IF n <> 1 THEN fails := fails || ' workspace_companies=' || n; END IF;

  -- mail
  SELECT workspace_id INTO id1 FROM public.connected_account WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'acct'); IF id1 <> d THEN fails := fails || ' account_not_rehomed'; END IF;
  SELECT count(*) INTO n FROM public.connected_account_workspace WHERE account_id = (SELECT v FROM pg_temp.e2e WHERE k = 'acct'); IF n <> 1 THEN fails := fails || ' account_links=' || n; END IF;
  IF EXISTS (SELECT 1 FROM public.email_thread_index WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 't1s')) THEN fails := fails || ' t1_copy_not_folded'; END IF;
  SELECT is_starred INTO ok FROM public.email_thread_index WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 't1d'); IF NOT ok THEN fails := fails || ' t1_star_not_unioned'; END IF;
  SELECT count(*) INTO n FROM public.email_thread_label WHERE thread_id = (SELECT v FROM pg_temp.e2e WHERE k = 't1d') AND label_id = (SELECT v FROM pg_temp.e2e WHERE k = 'l_bug_d'); IF n <> 1 THEN fails := fails || ' t1_label_not_unioned=' || n; END IF;
  SELECT workspace_id, linked_contact_id INTO id1, id2 FROM public.email_thread_index WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 't2s'); IF id1 <> d OR id2 <> (SELECT v FROM pg_temp.e2e WHERE k = 'c1d') THEN fails := fails || ' t2_not_moved_or_relinked'; END IF;

  -- integrations
  SELECT count(*) INTO n FROM public.task_sync_state WHERE workspace_id = d AND provider = 'linear'; IF n <> 1 THEN fails := fails || ' linear_states=' || n; END IF;
  SELECT count(*) INTO n FROM public.task_sync_state WHERE workspace_id = d AND provider = 'jira'; IF n <> 1 THEN fails := fails || ' jira_state=' || n; END IF;
  SELECT count(*) INTO n FROM public.action_external_task WHERE action_id = (SELECT v FROM pg_temp.e2e WHERE k = 'a_mkt2'); IF n <> 0 THEN fails := fails || ' linear_link_not_severed'; END IF;
  SELECT links::text INTO txt FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a_mkt2'); IF txt NOT LIKE '%linear.app/e2e/LIN-1%' THEN fails := fails || ' linear_url_not_kept'; END IF;
  SELECT count(*) INTO n FROM public.action_external_task WHERE action_id = (SELECT v FROM pg_temp.e2e WHERE k = 'a_dsg') AND workspace_id = d; IF n <> 1 THEN fails := fails || ' jira_link_not_moved'; END IF;

  -- flows and bots
  IF EXISTS (SELECT 1 FROM public.flow WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'f_triage_s')) THEN fails := fails || ' s_triage_not_dropped'; END IF;
  SELECT count(*) INTO n FROM public.flow_run WHERE flow_id = (SELECT v FROM pg_temp.e2e WHERE k = 'f_triage_d'); IF n <> 1 THEN fails := fails || ' triage_runs=' || n; END IF;
  SELECT workspace_id, team_id, trigger_config::text INTO id1, id2, txt FROM public.flow WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'f_other_s');
  IF id1 <> d OR id2 <> (SELECT v FROM pg_temp.e2e WHERE k = 'd_mkt') THEN fails := fails || ' flow_team_not_folded'; END IF;
  IF txt LIKE '%' || (SELECT v FROM pg_temp.e2e WHERE k = 's_mkt_qa')::text || '%' OR txt LIKE '%' || (SELECT v FROM pg_temp.e2e WHERE k = 's_mkt')::text || '%' THEN fails := fails || ' flow_config_not_rewritten'; END IF;
  SELECT count(*) INTO n FROM public.ai_team_member WHERE workspace_id = d AND is_system; IF n <> 6 THEN fails := fails || ' system_teammates=' || n; END IF;
  SELECT count(*) INTO n FROM public.ai_team_member WHERE workspace_id = d; IF n <> 6 THEN fails := fails || ' teammates_total=' || n; END IF;
  SELECT ai_team_member_id, title INTO id1, txt FROM public.chat_conversations WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'conv_bot_s'); IF id1 IS NOT NULL OR txt NOT LIKE '% · Coherix E2E' THEN fails := fails || ' bot_thread_not_demoted=' || COALESCE(txt, 'null'); END IF;
  SELECT ai_team_member_id INTO id1 FROM public.chat_conversations WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'conv_bot_d'); IF id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'bot_mail_d') THEN fails := fails || ' d_bot_thread_changed'; END IF;

  -- chat
  SELECT is_home, title INTO ok, txt FROM public.chat_conversations WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'conv_home_s');
  IF ok IS NOT NULL OR txt <> 'Home · Coherix E2E' THEN fails := fails || ' home_not_demoted=' || COALESCE(txt, 'null'); END IF;
  SELECT is_home INTO ok FROM public.chat_conversations WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'conv_home_d'); IF ok IS NOT TRUE THEN fails := fails || ' d_home_changed'; END IF;
  SELECT eve_session_id, workspace_id INTO txt, id1 FROM public.chat_conversations WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'conv_eve_s'); IF txt IS NOT NULL OR id1 <> d THEN fails := fails || ' eve_session_not_cleared'; END IF;

  -- documents
  SELECT canon_key INTO txt FROM public.document WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'doc_prod_s'); IF txt IS NOT NULL THEN fails := fails || ' product_canon_not_demoted'; END IF;
  SELECT title INTO txt FROM public.document WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'doc_prod_s'); IF txt <> 'Product (from Coherix E2E)' THEN fails := fails || ' product_title=' || txt; END IF;
  SELECT canon_key INTO txt FROM public.document WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'doc_prod_d'); IF txt <> 'product' THEN fails := fails || ' d_product_changed'; END IF;
  SELECT slug, team_id INTO txt, id1 FROM public.document WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'doc_road_s'); IF txt = 'roadmap-e2e' OR txt NOT LIKE 'roadmap-e2e-%' OR id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'd_mkt') THEN fails := fails || ' roadmap=' || txt; END IF;

  -- views
  SELECT slug, team_id, filters::text INTO txt, id1, v_j FROM (SELECT slug, team_id, filters FROM public.view WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'view_s')) x;
  IF txt IS NULL OR txt = 'my-view-e2e' OR id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'd_mkt') THEN fails := fails || ' view_slug_or_team=' || COALESCE(txt, 'null'); END IF;
  IF v_j::text NOT LIKE '%' || (SELECT v FROM pg_temp.e2e WHERE k = 'd_mkt')::text || '%' OR v_j::text NOT LIKE '%' || (SELECT v FROM pg_temp.e2e WHERE k = 'l_bug_d')::text || '%' THEN fails := fails || ' view_filters_not_rewritten'; END IF;

  -- knowledge, reminder, device, skill, default project
  IF EXISTS (SELECT 1 FROM public.knowledge_brief WHERE workspace_id = s) THEN fails := fails || ' s_brief_left'; END IF;
  SELECT source_fingerprint INTO txt FROM public.knowledge_brief WHERE workspace_id = d AND scope_type = 'workspace'; IF txt IS NOT NULL THEN fails := fails || ' d_brief_fingerprint_not_nulled'; END IF;
  SELECT workspace_id INTO id1 FROM public.claim WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'claim_s'); IF id1 <> d THEN fails := fails || ' claim_not_moved'; END IF;
  SELECT count(*) INTO n FROM public.claim_source WHERE claim_id = (SELECT v FROM pg_temp.e2e WHERE k = 'claim_s') AND workspace_id = d; IF n <> 1 THEN fails := fails || ' claim_source=' || n; END IF;
  SELECT count(*) INTO n FROM public.reminder WHERE workspace_id = d AND entity_id = (SELECT v FROM pg_temp.e2e WHERE k = 'a1'); IF n <> 1 THEN fails := fails || ' reminder=' || n; END IF;
  SELECT active_workspace_id INTO id1 FROM public.device_token WHERE token_prefix = 'e2e' AND user_id = u1; IF id1 <> d THEN fails := fails || ' device_not_repointed'; END IF;
  SELECT count(*) INTO n FROM public.recipe WHERE workspace_id = d AND slug LIKE 'my-skill-e2e%'; IF n <> 2 THEN fails := fails || ' recipes=' || n; END IF;
  IF EXISTS (SELECT 1 FROM public.projects WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'proj_def_s')) THEN fails := fails || ' default_project_not_folded'; END IF;
  SELECT project_id INTO id1 FROM public.actions WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'a3'); IF id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'proj_def_d') THEN fails := fails || ' a3_project_not_repointed'; END IF;

  -- 408: enrollments survive a contact fold, a universal label stays universal
  SELECT status, contact_id, workspace_id INTO txt, id1, id2 FROM public.sequence_enrollment WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'enr_s');
  IF txt <> 'active' OR id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'c1d') OR id2 <> d THEN fails := fails || ' enrollment_on_folded_contact=' || COALESCE(txt, 'null'); END IF;
  SELECT status, contact_id, workspace_id INTO txt, id1, id2 FROM public.sequence_enrollment WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'enr_s2');
  IF txt <> 'active' OR id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'c2s') OR id2 <> d THEN fails := fails || ' enrollment_moved=' || COALESCE(txt, 'null'); END IF;
  SELECT status, contact_id, workspace_id INTO txt, id1, id2 FROM public.sequence_enrollment WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'enr_s3');
  IF txt <> 'exited' OR id1 <> (SELECT v FROM pg_temp.e2e WHERE k = 'c3d') OR id2 <> d THEN fails := fails || ' colliding_enrollment=' || COALESCE(txt, 'null'); END IF;
  SELECT status INTO txt FROM public.sequence_enrollment WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'enr_d3'); IF txt <> 'active' THEN fails := fails || ' d_enrollment=' || COALESCE(txt, 'null'); END IF;
  SELECT scopes IS NULL INTO ok FROM public.label WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'l_bug_d'); IF NOT ok THEN fails := fails || ' bug_label_narrowed'; END IF;
  IF (pre->'collisions'->>'sequence_enrollments_exited')::int <> 1 THEN fails := fails || ' preflight_enrollments_exited=' || (pre->'collisions'->>'sequence_enrollments_exited'); END IF;
  IF (res->'counts'->>'sequence_enrollments_exited')::int <> 1 THEN fails := fails || ' merge_enrollments_exited=' || (res->'counts'->>'sequence_enrollments_exited'); END IF;
  IF (res->'counts'->>'contacts_folded')::int <> 2 THEN fails := fails || ' contacts_folded=' || (res->'counts'->>'contacts_folded'); END IF;

  -- 417: the stale capture, the parked runs and the job waiting for review came over as they were
  SELECT workspace_id, status INTO id1, txt FROM public.captures WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'cap_stale'); IF id1 <> d OR txt <> 'active' THEN fails := fails || ' stale_capture=' || COALESCE(txt, 'missing'); END IF;
  SELECT workspace_id, status INTO id1, txt FROM public.agent_run WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'run_pr'); IF id1 <> d OR txt <> 'pr_open' THEN fails := fails || ' pr_open_run=' || COALESCE(txt, 'missing'); END IF;
  SELECT workspace_id, status INTO id1, txt FROM public.agent_run WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'run_wait'); IF id1 <> d OR txt <> 'needs_input' THEN fails := fails || ' needs_input_run=' || COALESCE(txt, 'missing'); END IF;
  SELECT workspace_id, status, member_id INTO id1, txt, id2 FROM public.tracked_job WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'job_review');
  IF id1 <> d OR txt <> 'needs_review' OR id2 <> (SELECT v FROM pg_temp.e2e WHERE k = 'm1d') THEN fails := fails || ' review_job=' || COALESCE(txt, 'missing'); END IF;

  -- 707: company stages fold by name; the source's own one follows the destination's
  SELECT count(*) INTO n FROM public.company_stage WHERE workspace_id = d;
  IF n <> 5 OR n <> (SELECT count(DISTINCT lower(btrim(name))) FROM public.company_stage WHERE workspace_id = d) THEN fails := fails || ' company_stages=' || n; END IF;
  SELECT count(*) INTO n FROM public.company_stage WHERE id IN ((SELECT v FROM pg_temp.e2e WHERE k = 'st_lead_s'), (SELECT v FROM pg_temp.e2e WHERE k = 'st_demo_s'));
  IF n <> 0 THEN fails := fails || ' source_default_stages_left=' || n; END IF;
  SELECT workspace_id, position INTO id1, n FROM public.company_stage WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'st_pilot_s');
  IF id1 IS DISTINCT FROM d OR n <= (SELECT max(position) FROM public.company_stage WHERE workspace_id = d AND id <> (SELECT v FROM pg_temp.e2e WHERE k = 'st_pilot_s')) THEN
    fails := fails || ' pilot_stage=' || COALESCE(n::text, 'missing'); END IF;
  SELECT stage_id, owner_member_id INTO id1, id2 FROM public.company WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'co_only');
  IF id1 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'st_demo_d') THEN fails := fails || ' only_co_stage'; END IF;
  IF id2 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'm2d') THEN fails := fails || ' only_co_owner'; END IF;
  SELECT stage_id INTO id1 FROM public.company WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'co_pilot');
  IF id1 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'st_pilot_s') THEN fails := fails || ' pilot_co_stage'; END IF;
  SELECT stage_id, owner_member_id INTO id1, id2 FROM public.company WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'co_acme_d');
  IF id1 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'st_lead_d') THEN fails := fails || ' acme_folded_stage'; END IF;
  IF id2 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'm3s') THEN fails := fails || ' acme_folded_owner'; END IF;
  SELECT filters::text INTO txt FROM public.view WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'view_st');
  IF txt IS NULL OR position((SELECT v FROM pg_temp.e2e WHERE k = 'st_demo_d')::text IN txt) = 0 THEN fails := fails || ' stage_view_filter'; END IF;
  SELECT count(*) INTO n FROM public.comment WHERE commentable_type::text = 'company' AND commentable_id = (SELECT v FROM pg_temp.e2e WHERE k = 'co_acme_d');
  IF n <> 1 THEN fails := fails || ' company_comment=' || n; END IF;
  SELECT count(*) INTO n FROM public.company_email_consent WHERE company_id = (SELECT v FROM pg_temp.e2e WHERE k = 'co_acme_d') AND user_id = u1 AND revoked_at IS NULL;
  IF n <> 1 THEN fails := fails || ' email_consent=' || n; END IF;

  -- 707: team chat
  SELECT count(*) INTO n FROM public.team_chat_channel WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'dm_s');
  IF n <> 0 THEN fails := fails || ' dm_not_folded'; END IF;
  SELECT channel_id INTO id1 FROM public.team_chat_message WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'msg_s');
  IF id1 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'dm_d') THEN fails := fails || ' dm_message'; END IF;
  SELECT count(*) INTO n FROM public.team_chat_member WHERE channel_id = (SELECT v FROM pg_temp.e2e WHERE k = 'dm_d');
  IF n <> 2 THEN fails := fails || ' dm_members=' || n; END IF;
  SELECT count(*) INTO n FROM public.team_chat_member WHERE channel_id = (SELECT v FROM pg_temp.e2e WHERE k = 'dm_d')
    AND member_id = (SELECT v FROM pg_temp.e2e WHERE k = 'm2d') AND last_read_at > now() - interval '90 minutes';
  IF n <> 1 THEN fails := fails || ' dm_read_mark'; END IF;
  SELECT count(*) INTO n FROM public.team_chat_reaction WHERE message_id = (SELECT v FROM pg_temp.e2e WHERE k = 'msg_s')
    AND member_id IN ((SELECT v FROM pg_temp.e2e WHERE k = 'm1d'), (SELECT v FROM pg_temp.e2e WHERE k = 'm2d'));
  IF n <> 2 THEN fails := fails || ' dm_reactions=' || n; END IF;
  SELECT member_id, channel_id INTO id1, id2 FROM public.team_chat_thread_member WHERE root_id = (SELECT v FROM pg_temp.e2e WHERE k = 'msg_s');
  IF id1 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'm2d') OR id2 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'dm_d') THEN fails := fails || ' dm_thread_member'; END IF;
  SELECT dm_key, workspace_id INTO txt, id1 FROM public.team_chat_channel WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'dm3_s');
  IF id1 IS DISTINCT FROM d OR txt IS DISTINCT FROM (SELECT CASE WHEN a::text < b::text THEN a::text || ':' || b::text ELSE b::text || ':' || a::text END
                                   FROM (SELECT (SELECT v FROM pg_temp.e2e WHERE k = 'm1d') a, (SELECT v FROM pg_temp.e2e WHERE k = 'm3s') b) x) THEN
    fails := fails || ' dm_rekey=' || COALESCE(txt, 'missing'); END IF;
  SELECT name, workspace_id INTO txt, id1 FROM public.team_chat_channel WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'ch_s');
  IF id1 IS DISTINCT FROM d OR txt IS DISTINCT FROM 'General (Coherix E2E)' THEN fails := fails || ' channel_name=' || COALESCE(txt, 'missing'); END IF;

  SELECT team_id INTO id1 FROM public.team_chat_channel WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'ch_mkt');
  IF id1 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'd_mkt') THEN fails := fails || ' team_channel'; END IF;

  -- 707: what a folded member made or was given names the destination member
  SELECT count(*) INTO n FROM public.spreadsheet WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'sheet') AND created_by = (SELECT v FROM pg_temp.e2e WHERE k = 'm2d') AND last_edited_by = created_by;
  IF n <> 1 THEN fails := fails || ' spreadsheet_member'; END IF;
  SELECT count(*) INTO n FROM public.canvas WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'cnv') AND owner_member_id = (SELECT v FROM pg_temp.e2e WHERE k = 'm2d');
  IF n <> 1 THEN fails := fails || ' canvas_owner'; END IF;
  SELECT count(*) INTO n FROM public.drive_folder WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'fold') AND created_by = (SELECT v FROM pg_temp.e2e WHERE k = 'm2d');
  IF n <> 1 THEN fails := fails || ' drive_folder_member'; END IF;
  SELECT count(*) INTO n FROM public.conversation_share WHERE conversation_id = (SELECT v FROM pg_temp.e2e WHERE k = 'conv') AND grantee_member_id = (SELECT v FROM pg_temp.e2e WHERE k = 'm2d');
  IF n <> 1 THEN fails := fails || ' conversation_share'; END IF;
  SELECT count(*) INTO n FROM public.email_thread_share WHERE owner_user_id = u1 AND provider_thread_id = 'T1-e2e' AND revoked_at IS NULL
    AND grantee_member_id = (SELECT v FROM pg_temp.e2e WHERE k = 'm2d') AND thread_index_id = (SELECT v FROM pg_temp.e2e WHERE k = 't1d');
  IF n <> 1 THEN fails := fails || ' thread_share=' || n; END IF;

  -- 707: one per person
  SELECT count(*) INTO n FROM public.vocabulary_term WHERE workspace_id = d AND user_id = u1;
  IF n <> 2 THEN fails := fails || ' vocabulary=' || n; END IF;
  SELECT count(*) INTO n FROM public.email_auto_archive WHERE workspace_id = d AND user_id = u1 AND local_date = current_date;
  SELECT thread_ids @> ARRAY['th-s', 'th-d'] INTO ok FROM public.email_auto_archive WHERE workspace_id = d AND user_id = u1 AND local_date = current_date LIMIT 1;
  IF n <> 1 OR NOT COALESCE(ok, false) THEN fails := fails || ' auto_archive=' || n; END IF;
  SELECT count(*) INTO n FROM public.email_thread_team_private WHERE workspace_id = d AND owner_user_id = u1 AND provider_thread_id = 'T1-e2e';
  IF n <> 1 THEN fails := fails || ' private_thread=' || n; END IF;
  SELECT count(*) INTO n FROM public.booking_profile WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'bp_s');
  IF n <> 0 THEN fails := fails || ' booking_profile_left'; END IF;
  SELECT profile_id, slug INTO id1, txt FROM public.booking_link WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'bl_s');
  IF id1 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'bp_d') OR txt IS DISTINCT FROM 'intro-2' THEN fails := fails || ' booking_link=' || COALESCE(txt, 'missing'); END IF;
  SELECT grantee_team_id INTO id1 FROM public.entity_access WHERE entity_type = 'document' AND entity_id = (SELECT v FROM pg_temp.e2e WHERE k = 'doc_grant') AND grantee_kind = 'team';
  IF id1 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'd_mkt') THEN fails := fails || ' team_grant'; END IF;
  IF refusals->>'front_door' NOT LIKE 'P0008%business phone%' THEN fails := fails || ' front_door=' || COALESCE(refusals->>'front_door', 'missing'); END IF;

  -- 707: the batch merged after 705
  SELECT count(*) INTO n FROM public.snippet WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'sn_same');
  IF n <> 0 THEN fails := fails || ' snippet_same_not_folded'; END IF;
  SELECT count(*) INTO n FROM public.snippet WHERE workspace_id = d AND visibility = 'workspace' AND shortcut = 'thanks';
  IF n <> 1 THEN fails := fails || ' snippet_thanks=' || n; END IF;
  SELECT shortcut INTO txt FROM public.snippet WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'sn_other');
  IF txt IS DISTINCT FROM 'hours-2' THEN fails := fails || ' snippet_other=' || COALESCE(txt, 'missing'); END IF;
  SELECT shortcut, created_by INTO txt, id1 FROM public.snippet WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'sn_mine');
  IF txt IS DISTINCT FROM 'sig-2' OR id1 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'm2d') THEN fails := fails || ' snippet_personal=' || COALESCE(txt, 'missing'); END IF;
  SELECT workspace_id, created_by INTO id1, id2 FROM public.snippet WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'sn_only');
  IF id1 IS DISTINCT FROM d OR id2 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'm2d') THEN fails := fails || ' snippet_only'; END IF;
  SELECT created_by, closed_by INTO id1, id2 FROM public.team_chat_poll WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'poll') AND workspace_id = d;
  IF id1 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'm2d') OR id2 IS DISTINCT FROM id1 THEN fails := fails || ' poll_members'; END IF;
  SELECT count(*) INTO n FROM public.team_chat_poll_vote WHERE poll_id = (SELECT v FROM pg_temp.e2e WHERE k = 'poll') AND member_id = (SELECT v FROM pg_temp.e2e WHERE k = 'm2d') AND workspace_id = d;
  IF n <> 1 THEN fails := fails || ' poll_vote=' || n; END IF;
  SELECT member_id INTO id1 FROM public.work_import WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'imp') AND workspace_id = d;
  IF id1 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'm2d') THEN fails := fails || ' work_import'; END IF;
  SELECT count(*), max(held_until) > now() + interval '2 days' INTO n, ok FROM public.inbox_hold WHERE workspace_id = d AND user_id = u1 AND item_key = 'mail:T1-e2e';
  IF n <> 1 OR NOT COALESCE(ok, false) THEN fails := fails || ' inbox_hold=' || n; END IF;
  SELECT count(*) INTO n FROM public.crm_source_link WHERE workspace_id = d AND source = 'hubspot' AND external_id = 'hs-e2e-1';
  IF n <> 1 THEN fails := fails || ' crm_source_link=' || n; END IF;
  SELECT count(*) INTO n FROM public.workspace_github_repo WHERE workspace_id = d AND repo_full_name = 'example/e2e-repo';
  IF n <> 1 THEN fails := fails || ' github_repo=' || n; END IF;
  SELECT form_id, workspace_id INTO id1, id2 FROM public.booking_link WHERE id = (SELECT v FROM pg_temp.e2e WHERE k = 'bl_form');
  IF id1 IS DISTINCT FROM (SELECT v FROM pg_temp.e2e WHERE k = 'frm') OR id2 IS DISTINCT FROM d
     OR (SELECT workspace_id FROM public.data_form WHERE id = id1) IS DISTINCT FROM d THEN fails := fails || ' booking_link_form'; END IF;
  IF refusals->>'business_profile' NOT LIKE 'P0008%business profile%' THEN fails := fails || ' business_profile_refusal=' || COALESCE(refusals->>'business_profile', 'missing'); END IF;
  IF refusals->>'demo' NOT LIKE 'P0008%demo workspace%' THEN fails := fails || ' demo_refusal=' || COALESCE(refusals->>'demo', 'missing'); END IF;

  -- nothing left, destination clean
  SELECT count(*) INTO n FROM public.workspace_integrity_sweep(d); IF n <> 0 THEN fails := fails || ' sweep_violations=' || n; END IF;
  SELECT string_agg(k || '=' || (res->'counts'->>k), ' ') INTO txt FROM jsonb_object_keys(res->'counts') k WHERE k <> 'restamped' AND k <> 'identifier_map';

  RAISE EXCEPTION USING MESSAGE = 'E2E ' || CASE WHEN fails = '' THEN 'PASSED' ELSE 'FAILED:' || fails END
    || E'\n refusals=' || refusals::text
    || E'\n counts: ' || COALESCE(txt, '')
    || E'\n identifier_map=' || (res->'counts'->'identifier_map')::text
    || E'\n restamped=' || (res->'counts'->'restamped')::text
    || E'\n duration_ms=' || (res->>'duration_ms')
    || E'\n preflight.teams=' || (pre->'teams')::text
    || E'\n preflight.collisions=' || (pre->'collisions')::text;
END $$;
