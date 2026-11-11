-- DB-level test for migrations 555-559 (team chat, complete): threads, the
-- unread maths for threads, reactions, files on messages and in storage,
-- retry-safe sends, link previews and the typing topic. The TS tests
-- (src/lib/team-chat/__tests__/migration-555.test.ts) pin the files' text;
-- this runs the SQL.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/555_team_chat_complete.sql
-- Prints one line per probe and "555 team_chat_complete: all checks passed".
-- Everything runs in one transaction that is rolled back: throwaway users
-- (each gets a workspace of their own from handle_new_user), a channel, a
-- team channel, a DM and their messages. Each probe runs as one caller (role
-- authenticated with that user's JWT claims) inside its own block that
-- always rolls back, so one probe never sees another's writes.

begin;

do $probe$
declare
  u_a constant uuid := '00000000-0000-4000-8000-000000555001'; -- Ana, member of W1, in the team
  u_b constant uuid := '00000000-0000-4000-8000-000000555002'; -- Ben, member of W1, not in the team
  u_c constant uuid := '00000000-0000-4000-8000-000000555003'; -- Cy, member of W1, not in the DM
  u_x constant uuid := '00000000-0000-4000-8000-000000555004'; -- outsider: their own workspace only
  u_g constant uuid := '00000000-0000-4000-8000-000000555005'; -- Gil, a guest of W1
  w1 uuid; wx uuid; t1 uuid;
  m_a uuid; m_b uuid; m_c uuid; m_x uuid; m_g uuid;
  ch_open uuid; ch_team uuid; ch_dm uuid; ch_old uuid;
  root_a uuid; reply_b uuid; root_team uuid; msg_dm uuid; msg_gone uuid; msg_old uuid;
  t0 timestamptz := now() - interval '1 hour';
  f_open text; f_team text; f_dm text;
  v_report text;
  v_fail int;
  -- true: always end by raising the report (how it runs through a single
  -- statement, e.g. the Supabase MCP or CLI); false: raise only when a check fails.
  v_raise_report constant boolean := false;
begin
  create temp table t555_results (n serial, label text, expected text, got text, pass boolean) on commit drop;

  -- Run p_sqls as one caller and return 'rows=N' (the last statement's row
  -- count) or 'refused [SQLSTATE] message'.
  create function pg_temp.t555_probe(p_uid uuid, p_sqls text[], p_topic text default null)
  returns text language plpgsql as $f$
  declare
    n bigint := 0;
    s text;
  begin
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      if p_topic is not null then
        perform set_config('realtime.topic', p_topic, true);
      end if;
      perform set_config('role', 'authenticated', true);
      foreach s in array p_sqls loop
        execute s;
        get diagnostics n = row_count;
      end loop;
      raise exception using errcode = 'ZP555', message = 'rows=' || n;
    exception
      when sqlstate 'ZP555' then return sqlerrm;
      when others then return format('refused [%s] %s', sqlstate, sqlerrm);
    end;
  end $f$;

  create function pg_temp.t555_run(p_label text, p_expect text, p_uid uuid, p_sqls text[], p_topic text default null)
  returns void language plpgsql as $f$
  declare
    v_got text := pg_temp.t555_probe(p_uid, p_sqls, p_topic);
  begin
    insert into t555_results (label, expected, got, pass)
    values (p_label, p_expect, v_got, case when p_expect = 'refused' then v_got like 'refused%' else v_got = p_expect end);
  end $f$;

  -- ── Setup, as postgres with no request (trusted) ──────────────────────────
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_a, 't555-ana@example.invalid', '{"full_name":"t555ana"}'),
    (u_b, 't555-ben@example.invalid', '{"full_name":"t555ben"}'),
    (u_c, 't555-cy@example.invalid',  '{"full_name":"t555cy"}'),
    (u_x, 't555-out@example.invalid', '{"full_name":"t555outsider"}'),
    (u_g, 't555-gil@example.invalid', '{"full_name":"t555gil"}');

  select workspace_id, id into w1, m_a from public.member where user_id = u_a;
  select workspace_id, id into wx, m_x from public.member where user_id = u_x;
  insert into public.member (user_id, workspace_id, role, display_name) values
    (u_b, w1, 'member', 't555ben'),
    (u_c, w1, 'member', 't555cy'),
    (u_g, w1, 'guest', 't555gil');
  select id into m_b from public.member where user_id = u_b and workspace_id = w1;
  select id into m_c from public.member where user_id = u_c and workspace_id = w1;
  select id into m_g from public.member where user_id = u_g and workspace_id = w1;
  -- Everyone joined an hour ago: what is written after that is unread.
  update public.member set created_at = t0 where id in (m_a, m_b, m_c, m_g);

  insert into public.team (workspace_id, name, slug, issue_prefix) values (w1, 't555 team', 't555-team', 'TQY') returning id into t1;
  insert into public.team_member (team_id, member_id) values (t1, m_a);

  insert into public.team_chat_channel (workspace_id, kind, name, created_by) values (w1, 'channel', 't555-general', m_a) returning id into ch_open;
  insert into public.team_chat_channel (workspace_id, team_id, kind, name, created_by) values (w1, t1, 'channel', 't555-team', m_a) returning id into ch_team;
  insert into public.team_chat_channel (workspace_id, kind, name, created_by, archived_at) values (w1, 'channel', 't555-old', m_a, now()) returning id into ch_old;
  insert into public.team_chat_channel (workspace_id, kind, dm_key, created_by)
  values (w1, 'dm', case when m_a::text < m_b::text then m_a::text || ':' || m_b::text else m_b::text || ':' || m_a::text end, m_a) returning id into ch_dm;
  insert into public.team_chat_member (channel_id, member_id, workspace_id) values (ch_dm, m_a, w1), (ch_dm, m_b, w1);

  -- Ana's root, and Ben's reply in its thread mentioning Cy (as postgres: the clock is ours).
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at)
  values (ch_open, w1, m_a, 'shall we ship friday', t0 + interval '10 minutes') returning id into root_a;
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, mentions, thread_root_id, created_at)
  values (ch_open, w1, m_b, 'yes, and t555cy can check', array[m_c], root_a, t0 + interval '20 minutes') returning id into reply_b;
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at)
  values (ch_team, w1, m_a, 'team root', t0 + interval '10 minutes') returning id into root_team;
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at)
  values (ch_dm, w1, m_a, 'just us', t0 + interval '10 minutes') returning id into msg_dm;
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at, deleted_at)
  values (ch_open, w1, m_a, '', t0 + interval '11 minutes', now()) returning id into msg_gone;
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at)
  values (ch_old, w1, m_a, 'archived', t0 + interval '10 minutes') returning id into msg_old;
  -- Ana's reaction on her root (seen by the channel), via the function as Ana in a probe below.

  f_open := ch_open::text || '/' || u_b::text || '/' || gen_random_uuid()::text || '.png';
  f_team := ch_team::text || '/' || u_a::text || '/' || gen_random_uuid()::text || '.pdf';
  f_dm := ch_dm::text || '/' || u_a::text || '/' || gen_random_uuid()::text || '.png';
  insert into storage.objects (bucket_id, name, owner, metadata) values
    ('team-chat-files', f_team, u_a, '{"size": 10, "mimetype": "application/pdf"}'),
    ('team-chat-files', f_dm, u_a, '{"size": 10, "mimetype": "image/png"}');

  -- ── Threads ───────────────────────────────────────────────────────────────
  perform pg_temp.t555_run('member replies in a thread', 'rows=1', u_c,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, thread_root_id) values (%L, %L, %L, %L, %L)', ch_open, w1, m_c, 'on it', root_a)]);
  perform pg_temp.t555_run('a reply to a reply goes to the same root', 'rows=1', u_c,
    array[
      format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, thread_root_id) values (%L, %L, %L, %L, %L)', ch_open, w1, m_c, 'nested', reply_b),
      format('select 1 from public.team_chat_message where body = %L and thread_root_id = %L', 'nested', root_a)
    ]);
  perform pg_temp.t555_run('a thread root in another channel is refused', 'refused', u_a,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, thread_root_id) values (%L, %L, %L, %L, %L)', ch_open, w1, m_a, 'x', root_team)]);
  perform pg_temp.t555_run('member outside the team cannot reply in its thread', 'refused', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, thread_root_id) values (%L, %L, %L, %L, %L)', ch_team, w1, m_b, 'x', root_team)]);
  perform pg_temp.t555_run('member still cannot set in_reply_to (the agent''s)', 'refused', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, in_reply_to) values (%L, %L, %L, %L, %L)', ch_open, w1, m_b, 'x', root_a)]);
  perform pg_temp.t555_run('member cannot move a reply out of its thread', 'refused', u_b,
    array[format('update public.team_chat_message set thread_root_id = null where id = %L', reply_b)]);
  perform pg_temp.t555_run('the thread''s summary: one reply, Ben in it', 'rows=1', u_c,
    array[format('select 1 from public.team_chat_thread where root_id = %L and reply_count = 1 and participant_ids = array[%L]::uuid[]', root_a, m_b)]);
  perform pg_temp.t555_run('NON-MEMBER cannot read a thread''s summary', 'rows=0', u_x,
    array[format('select 1 from public.team_chat_thread where root_id = %L', root_a)]);
  perform pg_temp.t555_run('nobody writes a thread''s summary directly', 'refused', u_a,
    array[format('update public.team_chat_thread set reply_count = 99 where root_id = %L', root_a)]);
  perform pg_temp.t555_run('nobody joins a thread directly', 'refused', u_c,
    array[format('insert into public.team_chat_thread_member (root_id, member_id, channel_id, workspace_id, last_read_at) values (%L, %L, %L, %L, now())', root_team, m_c, ch_team, w1)]);

  perform pg_temp.t555_run('a deleted reply leaves the summary (count, last reply and repliers recomputed)', 'rows=1', u_b,
    array[
      format('update public.team_chat_message set deleted_at = now() where id = %L', reply_b),
      format('select 1 from public.team_chat_thread where root_id = %L and reply_count = 0 and last_reply_at is null and participant_ids = %L::uuid[]', root_a, '{}')
    ]);
  perform pg_temp.t555_run('a thread reply never moves its channel up the list', 'rows=1', u_c,
    array[
      format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, thread_root_id) values (%L, %L, %L, %L, %L)', ch_open, w1, m_c, 'quiet', root_a),
      format('select 1 from public.team_chat_channel where id = %L and last_message_at < now() - interval %L', ch_open, '30 minutes')
    ]);
  perform pg_temp.t555_run('an edit that mentions someone new brings them into the thread', 'rows=1', u_b,
    array[
      format('update public.team_chat_message set mentions = array[%L, %L]::uuid[] where id = %L', m_c, m_g, reply_b),
      format('select set_config(%L, %L, true)', 'request.jwt.claims', json_build_object('sub', u_g, 'role', 'authenticated')::text),
      format('select 1 from public.team_chat_thread_unread(%L) where root_id = %L and mentions = 1', w1, root_a)
    ]);
  -- Someone a reply mentions who can't read the channel is never brought in (checked as postgres: their rows aren't the replier's to read).
  insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, mentions, thread_root_id, created_at)
  values (ch_team, w1, m_a, 'for the team, cc t555ben', array[m_b], root_team, t0 + interval '30 minutes');
  insert into t555_results (label, expected, got, pass)
  select 'a mention never brings in someone who can''t read the channel', 'rows=0', 'rows=' || count(*), count(*) = 0
    from public.team_chat_thread_member where root_id = root_team and member_id = m_b;
  insert into t555_results (label, expected, got, pass)
  select 'the root''s author is in the thread (the same check lets them in)', 'rows=1', 'rows=' || count(*), count(*) = 1
    from public.team_chat_thread_member where root_id = root_team and member_id = m_a;

  -- ── Unread, with threads ──────────────────────────────────────────────────
  perform pg_temp.t555_run('a thread reply is never the channel''s unread (Ana: none)', 'rows=1', u_a,
    array[format('select 1 from public.team_chat_unread(%L) where channel_id = %L and unread = 0', w1, ch_open)]);
  perform pg_temp.t555_run('outside the thread, only the channel''s own messages count (Gil: the root)', 'rows=1', u_g,
    array[format('select 1 from public.team_chat_unread(%L) where channel_id = %L and unread = 1', w1, ch_open)]);
  perform pg_temp.t555_run('the root''s author has the reply unread in the thread', 'rows=1', u_a,
    array[format('select 1 from public.team_chat_thread_unread(%L) where root_id = %L and unread = 1 and mentions = 0', w1, root_a)]);
  perform pg_temp.t555_run('someone the reply mentions has it unread, as a mention', 'rows=1', u_c,
    array[format('select 1 from public.team_chat_thread_unread(%L) where root_id = %L and unread = 1 and mentions = 1', w1, root_a)]);
  perform pg_temp.t555_run('the replier has nothing unread (their own reply)', 'rows=0', u_b,
    array[format('select 1 from public.team_chat_thread_unread(%L)', w1)]);
  perform pg_temp.t555_run('someone not in the thread has nothing unread in it', 'rows=0', u_g,
    array[format('select 1 from public.team_chat_thread_unread(%L)', w1)]);
  perform pg_temp.t555_run('a new reply is unread for the replier''s thread mates, not the replier', 'rows=1', u_b,
    array[
      format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, thread_root_id) values (%L, %L, %L, %L, %L)', ch_open, w1, m_b, 'one more', root_a),
      format('select 1 from public.team_chat_thread_member where root_id = %L and member_id = %L and last_read_at >= now()', root_a, m_b)
    ]);
  perform pg_temp.t555_run('reading the thread clears it', 'rows=0', u_a,
    array[
      format('select public.team_chat_mark_thread_read(%L)', root_a),
      format('select 1 from public.team_chat_thread_unread(%L)', w1)
    ]);
  perform pg_temp.t555_run('NON-MEMBER cannot mark a thread read', 'refused', u_x,
    array[format('select public.team_chat_mark_thread_read(%L)', root_a)]);
  perform pg_temp.t555_run('member outside the team cannot mark its thread read', 'refused', u_b,
    array[format('select public.team_chat_mark_thread_read(%L)', root_team)]);
  perform pg_temp.t555_run('NON-MEMBER gets no thread unread', 'rows=0', u_x,
    array[format('select 1 from public.team_chat_thread_unread(%L)', w1)]);

  -- ── Reactions ─────────────────────────────────────────────────────────────
  perform pg_temp.t555_run('member reacts, and the channel sees it', 'rows=1', u_b,
    array[
      format('select public.team_chat_react(%L, %L, true)', root_a, '👍'),
      format('select 1 from public.team_chat_reaction where message_id = %L and member_id = %L and emoji = %L and active', root_a, m_b, '👍')
    ]);
  perform pg_temp.t555_run('reacting twice is one reaction', 'rows=1', u_b,
    array[
      format('select public.team_chat_react(%L, %L, true)', root_a, '🎉'),
      format('select public.team_chat_react(%L, %L, true)', root_a, '🎉'),
      format('select 1 from public.team_chat_reaction where message_id = %L and member_id = %L', root_a, m_b)
    ]);
  perform pg_temp.t555_run('taking one back turns it off (no row deleted)', 'rows=1', u_b,
    array[
      format('select public.team_chat_react(%L, %L, true)', root_a, '👀'),
      format('select public.team_chat_react(%L, %L, false)', root_a, '👀'),
      format('select 1 from public.team_chat_reaction where message_id = %L and member_id = %L and emoji = %L and not active', root_a, m_b, '👀')
    ]);
  perform pg_temp.t555_run('NON-MEMBER cannot react', 'refused', u_x,
    array[format('select public.team_chat_react(%L, %L, true)', root_a, '👍')]);
  perform pg_temp.t555_run('member outside the team cannot react in its channel', 'refused', u_b,
    array[format('select public.team_chat_react(%L, %L, true)', root_team, '👍')]);
  perform pg_temp.t555_run('member outside the DM cannot react in it', 'refused', u_c,
    array[format('select public.team_chat_react(%L, %L, true)', msg_dm, '👍')]);
  perform pg_temp.t555_run('nobody reacts in an archived channel', 'refused', u_a,
    array[format('select public.team_chat_react(%L, %L, true)', msg_old, '👍')]);
  perform pg_temp.t555_run('nobody reacts to a deleted message', 'refused', u_a,
    array[format('select public.team_chat_react(%L, %L, true)', msg_gone, '👍')]);
  perform pg_temp.t555_run('a reaction is an emoji, never words', 'refused', u_b,
    array[format('select public.team_chat_react(%L, %L, true)', root_a, 'lol')]);
  perform pg_temp.t555_run('nobody writes reactions directly', 'refused', u_b,
    array[format('insert into public.team_chat_reaction (message_id, member_id, emoji, channel_id, workspace_id) values (%L, %L, %L, %L, %L)', root_a, m_b, '👍', ch_open, w1)]);
  perform pg_temp.t555_run('NON-MEMBER cannot read reactions', 'rows=0', u_x,
    array[
      format('select 1 from public.team_chat_reaction where workspace_id = %L', w1)
    ]);

  -- ── Files ─────────────────────────────────────────────────────────────────
  perform pg_temp.t555_run('member uploads into their own folder of a channel they may post in', 'rows=1', u_b,
    array[format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'team-chat-files', f_open, u_b)]);
  perform pg_temp.t555_run('member cannot upload into someone else''s folder', 'refused', u_b,
    array[format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'team-chat-files', ch_open::text || '/' || u_a::text || '/x.png', u_b)]);
  perform pg_temp.t555_run('member outside the team cannot upload into its channel', 'refused', u_b,
    array[format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'team-chat-files', ch_team::text || '/' || u_b::text || '/x.png', u_b)]);
  perform pg_temp.t555_run('team member reads the team channel''s file', 'rows=1', u_a,
    array[format('select 1 from storage.objects where bucket_id = %L and name = %L', 'team-chat-files', f_team)]);
  perform pg_temp.t555_run('member outside the team cannot read its file', 'rows=0', u_b,
    array[format('select 1 from storage.objects where bucket_id = %L and name = %L', 'team-chat-files', f_team)]);
  perform pg_temp.t555_run('DM member reads the DM''s file', 'rows=1', u_b,
    array[format('select 1 from storage.objects where bucket_id = %L and name = %L', 'team-chat-files', f_dm)]);
  perform pg_temp.t555_run('member outside the DM cannot read its file', 'rows=0', u_c,
    array[format('select 1 from storage.objects where bucket_id = %L and name = %L', 'team-chat-files', f_dm)]);
  perform pg_temp.t555_run('NON-MEMBER reads no team chat file', 'rows=0', u_x,
    array[format('select 1 from storage.objects where bucket_id = %L', 'team-chat-files')]);
  perform pg_temp.t555_run('a message carries a file of the author''s own folder', 'rows=1', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, attachments) values (%L, %L, %L, %L, %L::jsonb)', ch_open, w1, m_b, '', json_build_array(json_build_object('path', f_open, 'name', 'shot.png', 'size', 10, 'type', 'image/png'))::text)]);
  perform pg_temp.t555_run('a message cannot carry another channel''s file', 'refused', u_a,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, attachments) values (%L, %L, %L, %L, %L::jsonb)', ch_open, w1, m_a, 'see', json_build_array(json_build_object('path', f_team, 'name', 'plan.pdf', 'size', 10, 'type', 'application/pdf'))::text)]);
  perform pg_temp.t555_run('a message cannot carry someone else''s upload', 'refused', u_c,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, attachments) values (%L, %L, %L, %L, %L::jsonb)', ch_open, w1, m_c, 'see', json_build_array(json_build_object('path', f_open, 'name', 'shot.png', 'size', 10, 'type', 'image/png'))::text)]);
  perform pg_temp.t555_run('a file over 10 MB is refused even inserted directly', 'refused', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, attachments) values (%L, %L, %L, %L, %L::jsonb)', ch_open, w1, m_b, 'big', json_build_array(json_build_object('path', f_open, 'name', 'shot.png', 'size', 20971520, 'type', 'image/png'))::text)]);
  perform pg_temp.t555_run('a file of a type a message may not carry is refused', 'refused', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, attachments) values (%L, %L, %L, %L, %L::jsonb)', ch_open, w1, m_b, 'page', json_build_array(json_build_object('path', f_open, 'name', 'shot.png', 'size', 10, 'type', 'text/html'))::text)]);
  perform pg_temp.t555_run('a file with no name, a long name or a size that isn''t a number is refused', 'refused', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, attachments) values (%L, %L, %L, %L, %L::jsonb)', ch_open, w1, m_b, 'odd', json_build_array(json_build_object('path', f_open, 'name', repeat('x', 201), 'size', 10, 'type', 'image/png'))::text)]);
  perform pg_temp.t555_run('a size that is not a number is refused, never cast', 'refused', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, attachments) values (%L, %L, %L, %L, %L::jsonb)', ch_open, w1, m_b, 'odd', json_build_array(json_build_object('path', f_open, 'name', 'a.png', 'size', 'lots', 'type', 'image/png'))::text)]);
  perform pg_temp.t555_run('an empty message without files is still refused', 'refused', u_b,
    array[format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body) values (%L, %L, %L, %L)', ch_open, w1, m_b, '')]);

  -- ── Retry-safe sends and link previews ────────────────────────────────────
  perform pg_temp.t555_run('a retried send (same client id) is refused as a duplicate', 'refused', u_b,
    array[
      format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, client_id) values (%L, %L, %L, %L, %L)', ch_open, w1, m_b, 'once', '00000000-0000-4000-8000-0000005550c1'),
      format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, client_id) values (%L, %L, %L, %L, %L)', ch_open, w1, m_b, 'once', '00000000-0000-4000-8000-0000005550c1')
    ]);
  perform pg_temp.t555_run('the same client id from another author is theirs', 'rows=1', u_c,
    array[
      format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, client_id) values (%L, %L, %L, %L, %L)', ch_open, w1, m_c, 'mine', '00000000-0000-4000-8000-0000005550c1')
    ]);
  perform pg_temp.t555_run('a client''s link preview is dropped on insert', 'rows=1', u_b,
    array[
      format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, link_preview) values (%L, %L, %L, %L, %L::jsonb)', ch_open, w1, m_b, 'fake preview', '{"title":"Totally real"}'),
      format('select 1 from public.team_chat_message where body = %L and link_preview is null', 'fake preview')
    ]);
  perform pg_temp.t555_run('member cannot write a link preview', 'refused', u_b,
    array[format('update public.team_chat_message set link_preview = %L::jsonb where id = %L', '{"title":"x"}', reply_b)]);
  perform pg_temp.t555_run('member cannot swap a message''s files', 'refused', u_b,
    array[format('update public.team_chat_message set attachments = %L::jsonb where id = %L', json_build_array(json_build_object('path', f_team, 'name', 'plan.pdf'))::text, reply_b)]);
  perform pg_temp.t555_run('member cannot change a client id', 'refused', u_b,
    array[format('update public.team_chat_message set client_id = gen_random_uuid() where id = %L', reply_b)]);
  perform pg_temp.t555_run('a delete clears the files and the preview with the words', 'rows=1', u_b,
    array[
      format('insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, attachments, client_id) values (%L, %L, %L, %L, %L::jsonb, %L)', ch_open, w1, m_b, 'bye', json_build_array(json_build_object('path', f_open, 'name', 'shot.png', 'size', 10, 'type', 'image/png'))::text, '00000000-0000-4000-8000-0000005550d1'),
      format('update public.team_chat_message set deleted_at = now() where client_id = %L', '00000000-0000-4000-8000-0000005550d1'),
      format('select 1 from public.team_chat_message where client_id = %L and body = %L and attachments = %L::jsonb and link_preview is null', '00000000-0000-4000-8000-0000005550d1', '', '[]')
    ]);

  -- ── Typing (the private broadcast topic) ──────────────────────────────────
  perform pg_temp.t555_run('DM member may hear the DM''s typing', 'rows=1', u_b,
    array[format('select 1 where public.team_chat_can_read(public.team_chat_typing_channel(%L))', 'team-chat-typing:' || ch_dm::text)]);
  perform pg_temp.t555_run('member outside the DM may not hear it', 'rows=0', u_c,
    array[format('select 1 where public.team_chat_can_read(public.team_chat_typing_channel(%L))', 'team-chat-typing:' || ch_dm::text)]);
  perform pg_temp.t555_run('a malformed topic is nobody''s channel', 'rows=1', u_a,
    array[format('select 1 where public.team_chat_typing_channel(%L) is null and public.team_chat_typing_channel(%L) is null', 'team-chat-typing:nope', 'agent-nudge:' || ch_open::text)]);

  -- ── Guests (role guest): exactly what a member may, never more ────────────
  perform pg_temp.t555_run('guest reads the open channel''s thread summary', 'rows=1', u_g,
    array[format('select 1 from public.team_chat_thread where root_id = %L', root_a)]);
  perform pg_temp.t555_run('guest cannot read the team channel''s file', 'rows=0', u_g,
    array[format('select 1 from storage.objects where bucket_id = %L and name = %L', 'team-chat-files', f_team)]);
  perform pg_temp.t555_run('guest cannot react in a DM they are not in', 'refused', u_g,
    array[format('select public.team_chat_react(%L, %L, true)', msg_dm, '👍')]);

  -- ── Report ────────────────────────────────────────────────────────────────
  select string_agg(format('%s %s: expected %s, got %s', case when pass then 'PASS' else 'FAIL' end, label, expected, got), chr(10) order by n),
         count(*) filter (where not pass)
    into v_report, v_fail
    from t555_results;
  raise notice '%', v_report;
  if v_fail > 0 then
    raise exception '555 team_chat_complete: % of % check(s) failed: %', v_fail, (select count(*) from t555_results),
      (select string_agg(label || ' (got ' || got || ')', '; ' order by n) from t555_results where not pass)
      using detail = v_report;
  end if;
  if v_raise_report then
    raise exception '555 team_chat_complete: all % checks passed', (select count(*) from t555_results) using detail = v_report;
  end if;
  raise notice '555 team_chat_complete: all checks passed';
end
$probe$;

rollback;
