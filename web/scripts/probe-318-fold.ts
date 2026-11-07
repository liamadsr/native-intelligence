/**
 * A rolled-back probe of migration 318's fold (section 7) against seeded rows.
 * Vitest can't run SQL, so this prints one SQL batch to run on DEV (the
 * Supabase SQL editor, or the MCP's execute_sql). It:
 *
 *   1. opens a transaction and builds a pre-318 workspace: a fresh workspace,
 *      team and member, and its four old system teammates (Triage, Extraction,
 *      Reconciler, and an Email drafts someone renamed "Inbox pal"), with the
 *      key CHECK and 283's guard set aside the way a pre-318 database had
 *      them;
 *   2. seeds what points at them: a ledger row, notices (one with the old
 *      title and teammate_name), a card, an empty Extraction thread, and a
 *      Reconciler thread with a message beside the person's Triage thread;
 *   3. runs section 7 of supabase/migrations/318_area_faces.sql VERBATIM (read
 *      from the file, up to its COMMIT);
 *   4. asserts the outcome in a DO block (any miss raises, naming it), then
 *      ROLLS BACK: DEV is left exactly as it was.
 *
 * A clean run (no error) is the pass. Prints SQL only; it connects to nothing.
 *
 * Usage:
 *   npx tsx scripts/probe-318-fold.ts > /tmp/probe.sql   # then run it on DEV
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Section 7 of 318, as the file has it: from its heading to the COMMIT. */
export function foldSection(sql: string): string {
  const start = sql.indexOf('-- 7. The fold')
  const end = sql.lastIndexOf('\ncommit;')
  if (start === -1 || end === -1 || end < start) throw new Error('318: section 7 or its COMMIT not found')
  // Back to the start of the heading's rule line.
  const from = sql.lastIndexOf('\n', sql.lastIndexOf('\n', start) - 1) + 1
  return sql.slice(from, end)
}

const SETUP = `
begin;
set local lock_timeout = '5s';

create temp table probe on commit drop as
select gen_random_uuid() as ws, (select id from auth.users order by created_at limit 1) as uid;

insert into public.workspace (id, name, slug)
select ws, 'Probe 318', 'probe-318-' || left(ws::text, 8) from probe;
insert into public.team (workspace_id, name, slug, issue_prefix)
select ws, 'Probe', 'probe-' || left(ws::text, 8), 'PRB' from probe
where not exists (select 1 from public.team t join probe p on t.workspace_id = p.ws);
insert into public.member (workspace_id, user_id, display_name)
select ws, uid, 'Probe' from probe
where not exists (select 1 from public.member m join probe p on m.workspace_id = p.ws and m.user_id = p.uid);

-- A pre-318 database: the old keys allowed, and whatever a seed made here gone.
alter table public.ai_team_member drop constraint if exists ai_team_member_system_key_check;
alter table public.ai_team_member disable trigger ai_team_member_protect_system;
delete from public.ai_team_member a using probe p where a.workspace_id = p.ws;

create temp table probe_mate on commit drop as
select k.key, k.name, gen_random_uuid() as id
from (values ('triage', 'Triage'), ('extraction', 'Extraction'), ('reconciler', 'Reconciler'), ('email_drafts', 'Inbox pal')) as k(key, name);

insert into public.ai_team_member (id, workspace_id, team_id, name, agent_recipe_id, is_system, system_key)
select m.id, p.ws, (select t.id from public.team t where t.workspace_id = p.ws order by t.created_at limit 1), m.name, r.id, true, m.key
from probe_mate m cross join probe p
join public.recipe r on r.slug = 'loop-' || replace(m.key, '_', '-') and r.workspace_id is null and r.category = 'agent';
alter table public.ai_team_member enable trigger ai_team_member_protect_system;

create temp table probe_ref on commit drop as
select gen_random_uuid() as job, gen_random_uuid() as note_triage, gen_random_uuid() as note_extraction,
       gen_random_uuid() as card, gen_random_uuid() as thread_triage, gen_random_uuid() as thread_extraction,
       gen_random_uuid() as thread_reconciler;

insert into public.tracked_job (id, workspace_id, member_id, kind, title, ai_team_member_id)
select r.job, p.ws, (select id from public.member where workspace_id = p.ws limit 1), 'extraction', 'Probe pass', (select id from probe_mate where key = 'extraction')
from probe_ref r cross join probe p;

insert into public.notification (id, workspace_id, recipient_id, type, title, metadata)
select r.note_triage, p.ws, (select id from public.member where workspace_id = p.ws limit 1), 'flow_run_output', 'Triage',
       jsonb_build_object('teammate_id', (select id from probe_mate where key = 'triage')::text, 'teammate_name', 'Triage', 'sentence', 's')
from probe_ref r cross join probe p
union all
select r.note_extraction, p.ws, (select id from public.member where workspace_id = p.ws limit 1), 'work_failed', 'Extraction',
       jsonb_build_object('teammate_id', (select id from probe_mate where key = 'extraction')::text, 'teammate_name', 'Extraction', 'sentence', 's')
from probe_ref r cross join probe p;

insert into public.attention_item (id, workspace_id, member_id, kind, title, payload)
select r.card, p.ws, (select id from public.member where workspace_id = p.ws limit 1), 'action_card', 'Probe card',
       jsonb_build_object('raised_by_ai_member_id', (select id from probe_mate where key = 'extraction')::text)
from probe_ref r cross join probe p;

insert into public.chat_conversations (id, user_id, workspace_id, title, ai_team_member_id)
select r.thread_triage, p.uid, p.ws, 'Triage', (select id from probe_mate where key = 'triage') from probe_ref r cross join probe p
union all
select r.thread_extraction, p.uid, p.ws, 'Extraction', (select id from probe_mate where key = 'extraction') from probe_ref r cross join probe p
union all
select r.thread_reconciler, p.uid, p.ws, 'Reconciler', (select id from probe_mate where key = 'reconciler') from probe_ref r cross join probe p;

insert into public.chat_messages (conversation_id, user_id, workspace_id, role, ui_message)
select r.thread_triage, p.uid, p.ws, 'user', '{"parts":[]}'::jsonb from probe_ref r cross join probe p
union all
select r.thread_reconciler, p.uid, p.ws, 'user', '{"parts":[]}'::jsonb from probe_ref r cross join probe p;
`

const ASSERT = `
do $probe$
declare
  v_ws uuid := (select ws from probe);
  v_triage uuid := (select id from probe_mate where key = 'triage');
  v_drafts uuid := (select id from probe_mate where key = 'email_drafts');
  r probe_ref%rowtype;
  v record;
begin
  select * into r from probe_ref;

  -- 7a: renamed in place, a chosen name kept.
  select system_key, name into v from public.ai_team_member where id = v_triage;
  if v.system_key is distinct from 'captures' or v.name is distinct from 'Captures' then raise exception 'probe: Triage not renamed to Captures in place (%)', v; end if;
  select system_key, name into v from public.ai_team_member where id = v_drafts;
  if v.system_key is distinct from 'mail' or v.name is distinct from 'Inbox pal' then raise exception 'probe: Email drafts not Mail with its chosen name (%)', v; end if;
  -- 7a: the renamed row's notice takes the new name and the area.
  select title, metadata into v from public.notification where id = r.note_triage;
  if v.title is distinct from 'Captures' or v.metadata->>'teammate_name' is distinct from 'Captures' or v.metadata->>'area' is distinct from 'captures'
     or v.metadata->>'teammate_id' is distinct from v_triage::text then
    raise exception 'probe: the renamed row''s notice kept its old name or lacks its area (%)', v;
  end if;

  -- The folded rows are gone, and everything that named them names Captures.
  if exists (select 1 from public.ai_team_member where workspace_id = v_ws and system_key in ('triage', 'extraction', 'reconciler', 'email_drafts')) then
    raise exception 'probe: an old-key row is left';
  end if;
  if (select ai_team_member_id from public.tracked_job where id = r.job) is distinct from v_triage then raise exception 'probe: the ledger row did not move to Captures'; end if;
  select title, metadata into v from public.notification where id = r.note_extraction;
  if v.metadata->>'teammate_id' is distinct from v_triage::text or v.title is distinct from 'Captures' or v.metadata->>'area' is distinct from 'captures' then
    raise exception 'probe: the folded row''s notice did not move (%)', v;
  end if;
  if (select payload->>'raised_by_ai_member_id' from public.attention_item where id = r.card) is distinct from v_triage::text then raise exception 'probe: the card did not move'; end if;

  -- Threads: the empty folded one is gone; the one with messages, beside the
  -- person's Captures thread, is a focused conversation under the default title.
  if exists (select 1 from public.chat_conversations where id = r.thread_extraction) then raise exception 'probe: the empty Extraction thread was kept'; end if;
  select ai_team_member_id, focus_area, title, eve_session_id into v from public.chat_conversations where id = r.thread_reconciler;
  if v.ai_team_member_id is not null or v.focus_area is distinct from 'captures' or v.title is distinct from 'New conversation' then
    raise exception 'probe: the Reconciler thread was not converted (%)', v;
  end if;
  if (select ai_team_member_id from public.chat_conversations where id = r.thread_triage) is distinct from v_triage then raise exception 'probe: the Triage thread moved'; end if;
  if (select count(*) from public.chat_messages where conversation_id = r.thread_reconciler) <> 1 then raise exception 'probe: the converted thread lost its message'; end if;

  -- The guard is back on and the new CHECK stands.
  if (select tgenabled from pg_trigger where tgname = 'ai_team_member_protect_system') <> 'O' then raise exception 'probe: 283''s guard left disabled'; end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_team_member_system_key_check') then raise exception 'probe: the key CHECK is missing'; end if;

  raise notice 'probe 318: section 7 ok';
end
$probe$;

rollback;
`

if (process.argv[1] && /probe-318-fold/.test(process.argv[1])) {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/318_area_faces.sql'), 'utf8')
  process.stdout.write(`${SETUP}\n-- ── 318, section 7, verbatim ──\n${foldSection(sql)}\n${ASSERT}`)
}
