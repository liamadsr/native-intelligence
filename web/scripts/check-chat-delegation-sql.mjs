/** Isolated migration contract check. No network or application DB access.
 * Requires @electric-sql/pglite in the executing directory. To keep this
 * optional test dependency out of the app, install it in a temporary directory
 * and run this file via stdin there using `node --input-type=module`, with
 * CHAT_DELEGATION_MIGRATION set to migration 296's absolute path, and
 * CHAT_DELEGATION_HARDENING to migration 299's to apply it on top. With 299,
 * every 296 assertion below runs against its nine-argument (release #565)
 * entry point, which is the backward-compatibility check, and the hardened
 * eleven-argument entry point is checked after it.
 * PGlite runs one PostgreSQL connection; these tests verify admission semantics,
 * not multi-connection locking. The RPC serializes production admissions by
 * locking the workspace row before its reads/counts/insert in one transaction.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const db = new PGlite()
const ws = '00000000-0000-4000-8000-000000000001'
const user = '00000000-0000-4000-8000-000000000002'
const conv = '00000000-0000-4000-8000-000000000003'
const team = '00000000-0000-4000-8000-000000000004'
const member = '00000000-0000-4000-8000-000000000005'
const target = '00000000-0000-4000-8000-000000000006'
const stranger = '00000000-0000-4000-8000-000000000007'
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table workspace (id uuid primary key, settings jsonb);
    create table member (id uuid primary key, workspace_id uuid, user_id uuid);
    create table chat_conversations (id uuid primary key, workspace_id uuid, user_id uuid);
    create table team (id uuid primary key, workspace_id uuid, is_private boolean);
    create table team_member (team_id uuid, member_id uuid);
    create table ai_team_member (id uuid primary key, team_id uuid, workspace_id uuid, role text,
      name text, autonomy text, is_system boolean, allowed_side_effects text[] not null default '{read}',
      created_at timestamptz default now());
    create table agent_run (id uuid primary key default gen_random_uuid(), workspace_id uuid,
      action_id uuid, flow_id uuid, parent_run_id uuid, kind text, status text, task_prompt text,
      resources jsonb, triggered_by uuid, origin text, origin_depth integer, ai_team_member_id uuid,
      fire_key text unique, expects jsonb, created_at timestamptz default now());
    create table tracked_job (origin text);
    create table test_meter (allowed boolean); insert into test_meter values (true);
    create function check_ai_usage_limit(uuid) returns table(allowed boolean) language sql as 'select allowed from test_meter';
    create function is_workspace_member(uuid) returns boolean language sql as 'select true';
    alter table agent_run enable row level security;
    grant usage on schema public to authenticated,service_role;
    grant select,insert,delete on agent_run to authenticated;
    create policy agent_run_select on agent_run for select using (true);
    insert into workspace values ('${ws}', '{}');
    insert into member values ('${member}','${ws}','${user}');
    insert into chat_conversations values ('${conv}','${ws}','${user}');
    insert into team values ('${team}','${ws}',false);
    insert into ai_team_member (id,team_id,workspace_id,role,name,autonomy,is_system,allowed_side_effects)
      values ('${target}','${team}','${ws}','researcher','Researcher','attempt',false,'{read,internal-write}');
  `)
  const migration = await readFile(process.env.CHAT_DELEGATION_MIGRATION ?? new URL('../supabase/migrations/296_chat_work_delegation.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  await db.exec(migration) // rerunnable
  const hardening = process.env.CHAT_DELEGATION_HARDENING ? await readFile(process.env.CHAT_DELEGATION_HARDENING, 'utf8') : null
  if (hardening) { await db.exec(hardening); await db.exec(hardening) } // rerunnable on top of 296
  let n = 0
  const launch = async ({ call = `call-${++n}`, who = user, conversation = conv, role = 'researcher', task = 'Research the topic', snapshot = [] } = {}) => {
    const { rows } = await db.query('select start_chat_work_delegation($1,$2,$3,$4,$5,$6,$7,$8,$9) as result', [ws,who,conversation,call,role,task,JSON.stringify(snapshot),'[]','[]'])
    return rows[0].result
  }
  const policy = async (p) => db.query('update workspace set settings = $1::jsonb', [JSON.stringify({ agent_autonomy: p })])
  const count = async () => Number((await db.query('select count(*) as n from agent_run')).rows[0].n)
  const first = await launch({ call:'stable' })
  assert.equal(first.status,'queued'); assert.equal(first.teammate_id,target)
  const replay = await launch({ call:'stable', snapshot:[{ type:'document', label:'Changed snapshot' }] })
  assert.equal(replay.run_id,first.run_id); assert.equal(replay.reused,true); assert.equal(await count(),1)
  assert.equal((await launch({ call:'stable', task:'Different task' })).code,'CALL_ID_CONFLICT')
  assert.equal((await launch({ who:stranger })).code,'NOT_A_MEMBER')
  assert.equal((await launch({ conversation:stranger })).code,'CONVERSATION_UNAVAILABLE')
  await db.exec(`insert into member values ('${stranger}','${ws}','${stranger}')`)
  assert.equal((await launch({ who:stranger })).code,'CONVERSATION_UNAVAILABLE')
  await db.exec('update team set is_private = true')
  assert.equal((await launch()).code,'NO_TEAMMATE_FOR_ROLE')
  await db.exec(`insert into team_member values ('${team}','${member}')`)
  assert.equal((await launch()).status,'queued')
  await db.exec("update ai_team_member set autonomy = 'off'")
  assert.equal((await launch()).code,'NO_TEAMMATE_FOR_ROLE')
  await db.exec("update ai_team_member set autonomy = 'attempt'")
  await policy({ mode:'off' }); assert.equal((await launch()).code,'AUTONOMY_OFF')
  await policy({ chat_can_delegate_to:[] }); assert.equal((await launch()).code,'DELEGATION_NOT_ALLOWED')
  for (const p of [{ chat_can_delegate_to:'writer' },{ chat_can_delegate_to:['boss'] }, {max_chat_delegations_per_day:'2'}, {max_chat_delegations_per_day:-1}, {max_chat_delegations_per_day:1.5}, {max_chat_delegations_per_conversation:null}, { mode:'unknown' }]) {
    await policy(p); assert.equal((await launch()).code,'POLICY_UNAVAILABLE',JSON.stringify(p))
  }
  await policy({}); assert.equal((await launch({role:'developer'})).code,'DELEGATION_ROLE_UNSUPPORTED')
  await db.exec('update test_meter set allowed=false'); assert.equal((await launch()).code,'USAGE_LIMIT')
  await db.exec('update test_meter set allowed=true')
  await policy({max_chat_delegations_per_day:2}); assert.equal((await launch()).code,'DAY_BUDGET')
  await policy({max_chat_delegations_per_conversation:2}); assert.equal((await launch()).code,'CONVERSATION_BUDGET')
  await policy({max_chat_delegations_per_conversation:3,max_chat_delegations_per_day:3})
  const batch = await Promise.all(Array.from({length:20},()=>launch()))
  assert.equal(batch.filter(r=>r.run_id).length,1); assert.equal(await count(),3)
  await db.exec(`insert into chat_conversations values ('${stranger}','${ws}','${stranger}')`)
  assert.equal((await launch({who:stranger,conversation:stranger})).code,'DAY_BUDGET')
  await db.exec(`update chat_conversations set workspace_id='00000000-0000-4000-8000-000000000008' where id='${stranger}'`)
  assert.equal((await launch({who:stranger,conversation:stranger})).code,'CONVERSATION_UNAVAILABLE')
  const conv2 = '00000000-0000-4000-8000-000000000009'
  const bound = ['create_document', 'get_capture_content']
  // p_turn_id is '<eve session id>:<eve turn id>' (a bare turn id is the pre-fix code's).
  const harden = async ({ turn = 'wrun_s1:turn_1', call = `v2-${++n}`, ceiling = bound, role = 'researcher', task = 'Research the topic', who = user } = {}) => {
    const { rows } = await db.query('select start_chat_work_delegation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result', [ws,who,conv2,turn,call,role,task,'[]','[]','[]',ceiling])
    return rows[0].result
  }
  if (hardening) {
    await policy({ max_chat_delegations_per_conversation:500, max_chat_delegations_per_day:500 })
    await db.exec(`insert into chat_conversations values ('${conv2}','${ws}','${user}')`)
    const stored = async (id) => (await db.query('select fire_key, chat_ceiling from agent_run where id = $1', [id])).rows[0]
    // The bound and a session- and turn-scoped key are stored; a reused call id in a later turn is new work.
    const a = await harden({ turn:'wrun_s1:turn_1', call:'reused-id' })
    assert.equal(a.status,'queued'); assert.equal(a.teammate_id,target)
    assert.deepEqual(await stored(a.run_id), { fire_key:`chat-delegate:${conv2}:session:wrun_s1:turn:turn_1:call:reused-id`, chat_ceiling:bound })
    assert.equal((await harden({ turn:'wrun_s1:turn_1', call:'reused-id' })).run_id, a.run_id)
    const b = await harden({ turn:'wrun_s1:turn_2', call:'reused-id' })
    assert.equal(b.reused,false); assert.notEqual(b.run_id,a.run_id)
    assert.equal((await harden({ turn:'wrun_s1:turn_1', call:'reused-id', task:'Changed' })).code,'CALL_ID_CONFLICT')
    // A new eve session restarts turn numbering: the same turn and call id there is new
    // work, even with a different brief (no CALL_ID_CONFLICT against the old session).
    const c = await harden({ turn:'wrun_s2:turn_1', call:'reused-id' })
    assert.equal(c.reused,false); assert.notEqual(c.run_id,a.run_id); assert.notEqual(c.run_id,b.run_id)
    assert.equal((await stored(c.run_id)).fire_key, `chat-delegate:${conv2}:session:wrun_s2:turn:turn_1:call:reused-id`)
    assert.equal((await harden({ turn:'wrun_s2:turn_1', call:'reused-id' })).run_id, c.run_id)
    const d = await harden({ turn:'wrun_s3:turn_1', call:'reused-id', task:'A different brief' })
    assert.equal(d.reused,false); assert.ok(d.run_id)
    // A bare turn id (the pre-fix code) still admits, under the session-less key.
    const bare = await harden({ turn:'turn_1', call:'reused-id' })
    assert.equal(bare.reused,false); assert.notEqual(bare.run_id,a.run_id)
    assert.equal((await stored(bare.run_id)).fire_key, `chat-delegate:${conv2}:turn:turn_1:call:reused-id`)
    for (const bad of [{ ceiling:null }, { turn:null }, { turn:'' }, { turn:':' }, { turn:'s:' }, { turn:':t' }, { turn:'s:t:u' }, { turn:'x'.repeat(201) },
      { turn:`${'x'.repeat(201)}:t` }, { turn:`s:${'x'.repeat(201)}` }, { ceiling:['ok', null] }, { ceiling:[''] }, { ceiling:Array.from({ length:1001 }, (_, i) => `t${i}`) }]) {
      assert.equal((await harden(bad)).code,'INVALID_BRIEF',JSON.stringify(bad).slice(0, 60))
    }
    assert.equal((await harden({ turn:`${'s'.repeat(200)}:${'t'.repeat(200)}` })).status,'queued') // each part may be 200
    assert.equal((await harden({ who:stranger })).code,'CONVERSATION_UNAVAILABLE') // a member, not the chat's owner
    // The nine-argument form records no bound and keeps its key.
    const legacy = await launch({ call:'legacy-bound' })
    assert.deepEqual(await stored(legacy.run_id), { fire_key:`chat-delegate:${conv}:legacy-bound`, chat_ceiling:null })
    // Routing: the oldest enabled holder that may draft, through both entry points.
    const reader = '00000000-0000-4000-8000-00000000000a', drafter = '00000000-0000-4000-8000-00000000000b'
    await db.exec(`insert into ai_team_member (id,team_id,workspace_id,role,name,autonomy,is_system,allowed_side_effects,created_at) values
      ('${reader}','${team}','${ws}','writer','Old reader','attempt',false,'{read}',now() - interval '2 days'),
      ('${drafter}','${team}','${ws}','writer','Young drafter','propose',false,'{read,internal-write}',now() - interval '1 day')`)
    assert.equal((await harden({ role:'writer' })).teammate_id,drafter)
    assert.equal((await launch({ role:'writer' })).teammate_id,drafter)
    await db.exec(`update ai_team_member set autonomy = 'off' where id = '${drafter}'`)
    assert.equal((await harden({ role:'writer' })).code,'TEAMMATE_CANNOT_DRAFT')
    assert.equal((await launch({ role:'writer' })).code,'TEAMMATE_CANNOT_DRAFT')
    await db.exec(`update ai_team_member set autonomy = 'off' where id = '${reader}'`)
    assert.equal((await harden({ role:'writer' })).code,'NO_TEAMMATE_FOR_ROLE')
    const src = (await db.query("select prosrc from pg_proc where proname = '_admit_chat_work_delegation'")).rows[0].prosrc
    assert.match(src,/for no key update/); assert.doesNotMatch(src,/p_workspace_id for update/)
  }
  const before = await count()
  await db.exec('set role authenticated')
  await assert.rejects(launch(),/permission denied for function/)
  if (hardening) {
    await assert.rejects(harden(),/permission denied for function/)
    await assert.rejects(db.query("select _admit_chat_work_delegation($1,$2,$3,'k','c','researcher','t','[]','[]','[]',null)",[ws,user,conv]),/permission denied for function/)
    await assert.rejects(db.query("insert into agent_run (workspace_id,origin,action_id,chat_ceiling) values ($1,'user',$2,'{}')",[ws,conv]),/row-level security/)
  }
  await assert.rejects(db.query("insert into agent_run (workspace_id,origin,chat_conversation_id) values ($1,'chat',$2)",[ws,conv]),/row-level security/)
  await assert.rejects(db.query("insert into agent_run (workspace_id,origin,action_id,fire_key) values ($1,'user',$2,'chat-delegate:reserved')",[ws,conv]),/row-level security/)
  await db.exec('delete from agent_run')
  await db.exec('reset role'); assert.equal(await count(),before)
  await db.exec('delete from chat_conversations')
  assert.equal(await count(),before); assert.equal((await launch({call:'stable'})).code,'CONVERSATION_UNAVAILABLE')
  console.log('PASS: migration rerun, replay/fingerprint, owner/tenancy, private-team access, mode/roles, malformed settings, usage, caps, member RLS, and deleted-chat provenance'
    + (hardening ? '; 299: legacy entry point unchanged, stored chat bound, session- and turn-scoped keys (a repeated turn id in a new eve session is new work), bare turn ids, malformed hardened calls, drafting-capable routing, no-key lock, body and new form closed to members' : ''))
} finally { await db.close() }
