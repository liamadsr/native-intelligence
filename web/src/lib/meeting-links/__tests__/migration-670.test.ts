/**
 * Migration 670: a meeting guest writes in the meeting's chat, and reads it,
 * while they are in its call.
 *
 * Two parts. The text checks always run: one transaction with a lock timeout,
 * no backslash, the guard is 564's with only the guest's columns added, the
 * search is 561's with only the guest's name added, the two new functions are
 * definers with their search_path pinned and the service role's alone, each
 * function's newest definition is this file's. The engine checks run the file
 * (twice: it is re-runnable) on PGlite over stand-ins for what it reads (the
 * real guards, policies and channel trigger copied from 474, 555 and 564), and
 * play a call through: a guest writes only while let into the live call and in
 * its room; reads only since they first came in, within 657's grace; a
 * signed-in member can neither write a guest's row nor edit one, nor put a
 * guest on their own.
 *
 * PGlite is not a dependency of this repository: the engine checks run only
 * where it resolves (`PGLITE_MODULE=/path/to/node_modules/@electric-sql/pglite/dist/index.js`
 * for a scratch install), and are skipped otherwise.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const FILE = '670_meeting_guest_chat.sql'
const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8')
const SQL = read(FILE)
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const flat = (sql: string) => bodyOf(sql).replace(/\s+/g, ' ').trim()

/** A statement of a file, from its start to the `$$;` that closes its body. */
function fnIn(sql: string, name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, 'i'))
  expect(start, name).toBeGreaterThanOrEqual(0)
  const open = sql.indexOf('$$', start)
  const close = sql.indexOf('$$;', open + 2)
  return sql.slice(start, close + 3)
}

/** A statement of a file, from `from` to the first `until` after it (included). */
function slice(sql: string, from: string, until: string): string {
  const start = sql.indexOf(from)
  expect(start, from).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf(until, start) + until.length)
}

describe('migration 670 (the text)', () => {
  it('is the only 670, one transaction with a lock timeout, reloads the API schema, holds no backslash', () => {
    expect(migrationsInOrder().filter((m) => m.num === 670)).toHaveLength(1)
    const body = bodyOf(SQL)
    expect(SQL).not.toContain('\\')
    expect(body).toMatch(/^\s*begin;\s*SET LOCAL lock_timeout = '5s';/)
    expect(body.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;")).toBe(true)
    expect(body).not.toMatch(/concurrently|vacuum|truncate|drop table|drop column/i)
  })

  it('adds the guest’s columns and widens the checks the house way (not valid, then validate)', () => {
    const f = flat(SQL)
    expect(f).toContain('add column if not exists guest_id uuid references public.meeting_guest(id) on delete set null')
    expect(f).toContain('add column if not exists guest_name text')
    for (const name of ['team_chat_message_author_kind', 'team_chat_message_guest_name', 'team_chat_message_author']) {
      expect(f).toContain(`alter table public.team_chat_message drop constraint if exists ${name};`)
      expect(f).toMatch(new RegExp(`add constraint ${name} check \\(.*?\\) not valid; alter table public.team_chat_message validate constraint ${name};`))
    }
    expect(f).toContain(
      "(author_kind = 'guest' and author_member_id is null and agent_name is null and agent_for_member_id is null and guest_name is not null)",
    )
  })

  it('the guard is 564’s, word for word, plus the guest’s two columns', () => {
    const old = fnIn(read('564_team_calls.sql'), 'team_chat_message_guard')
    const added = 'or (new.guest_id is not null and new.guest_id is distinct from old.guest_id) or new.guest_name is distinct from old.guest_name then'
    expect(flat(fnIn(SQL, 'team_chat_message_guard'))).toBe(flat(old).replace('or new.call_id is distinct from old.call_id then', `or new.call_id is distinct from old.call_id ${added}`))
  })

  it('the search is 561’s, word for word, but a guest’s message is never found', () => {
    const old = fnIn(read('561_team_chat_search.sql'), 'team_chat_search')
    expect(flat(fnIn(SQL, 'team_chat_search'))).toBe(
      flat(old).replace("and x.deleted_at is null and to_tsvector", "and x.deleted_at is null and x.author_kind <> 'guest' and to_tsvector"),
    )
    expect(flat(SQL)).toContain('revoke all on function public.team_chat_search(uuid, text, integer) from public, anon; grant execute on function public.team_chat_search(uuid, text, integer) to authenticated;')
  })

  it('the guest’s functions are definers with their search_path pinned, the service role’s alone; every function here is the newest definition', () => {
    const f = flat(SQL)
    for (const [name, args] of [
      ['meeting_guest_chat_post', 'uuid, text, text'],
      ['meeting_guest_chat_read', 'uuid, text, integer'],
      ['meeting_guest_chat_remove', 'uuid, uuid'],
    ]) {
      expect(flat(fnIn(SQL, name)), name).toContain('security definer set search_path = public, pg_temp')
      expect(f).toContain(`revoke all on function public.${name}(${args}) from public, anon, authenticated;`)
      expect(f).toContain(`grant execute on function public.${name}(${args}) to service_role;`)
    }
    for (const name of ['meeting_guest_chat_post', 'meeting_guest_chat_read', 'meeting_guest_chat_remove', 'team_chat_message_guard', 'team_chat_search']) {
      const newest = migrationsInOrder().filter((m) => m.sql.toLowerCase().includes(`create or replace function public.${name}(`)).at(-1)
      // 715 (support chat) restates the guard and the search from this file's text, adding only its own
      // columns and names (src/lib/support-chat/__tests__/migration-715.test.ts pins that); the guest's
      // own lines go on with them.
      const owner = name === 'team_chat_message_guard' || name === 'team_chat_search' ? '715_support_chat.sql' : FILE
      expect(newest?.file, name).toBe(owner)
    }
  })

  it('a guest’s post is a plain message and nothing else; the read never hands out ids, paths, previews or shares', () => {
    const post = flat(fnIn(SQL, 'meeting_guest_chat_post'))
    expect(post).toContain("values (g.channel_id, ws, 'guest', g.id, g.name, said, '{}', false, 'message')")
    expect(post).not.toMatch(/thread_root_id|attachments|link_preview|mentions_agent = true|notify|inngest/)
    const readFn = flat(fnIn(SQL, 'meeting_guest_chat_read'))
    const built = readFn.slice(readFn.indexOf('jsonb_build_object( '), readFn.indexOf(') order by l.created_at'))
    expect(built).not.toMatch(/author_member_id|agent_for_member_id|guest_id|path|link_preview|email_share_id|channel_id|workspace_id/)
    expect(readFn).toContain("and x.author_kind in ('member', 'guest')")
    expect(readFn).not.toContain('agent_name')
  })
})

// ── The engine ─────────────────────────────────────────────────────────────

interface Db {
  exec(sql: string): Promise<unknown>
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

async function loadPglite(): Promise<(new () => Db) | null> {
  const spec = process.env.PGLITE_MODULE || '@electric-sql/pglite'
  try {
    const mod = (await import(/* @vite-ignore */ spec)) as { PGlite: new () => Db }
    return mod.PGlite
  } catch {
    return null
  }
}

const PGlite = await loadPglite()

const T474 = read('474_team_chat.sql')
const T555 = read('555_team_chat_message_columns.sql')
const T564 = read('564_team_calls.sql')

/** What 670 reads and writes, as small as it can be; the guards, policies and the channel's trigger are the real ones. */
const STAND_INS = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;
create table public.member (id uuid primary key, workspace_id uuid not null, user_id uuid, display_name text);
create table public.team_chat_channel (
  id uuid primary key, workspace_id uuid not null, kind text not null, name text, dm_key text,
  archived_at timestamptz, last_message_at timestamptz
);
create table public.meeting (id uuid primary key, channel_id uuid not null, token_hash text not null, revoked_at timestamptz);
create table public.team_call (id uuid primary key, channel_id uuid not null, status text not null);
create table public.meeting_guest (
  id uuid primary key, meeting_id uuid not null references public.meeting(id), workspace_id uuid not null, channel_id uuid not null,
  name text not null check (char_length(name) between 1 and 60), state text not null, call_id uuid, in_call boolean not null default false,
  first_joined_at timestamptz, joined_at timestamptz, left_at timestamptz, requested_at timestamptz not null default now(), decided_at timestamptz
);
create table public.team_chat_message (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  workspace_id uuid not null,
  author_kind text not null default 'member' check (author_kind in ('member', 'agent')),
  author_member_id uuid references public.member(id) on delete set null,
  agent_for_member_id uuid references public.member(id) on delete set null,
  agent_name text,
  in_reply_to uuid,
  body text not null,
  mentions uuid[] not null default '{}',
  mentions_agent boolean not null default false,
  record_mentions jsonb not null default '[]'::jsonb,
  thread_root_id uuid references public.team_chat_message(id) on delete cascade,
  client_id uuid,
  attachments jsonb not null default '[]'::jsonb,
  link_preview jsonb,
  kind text not null default 'message',
  call_id uuid,
  email_share_id uuid,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint team_chat_message_author check (
    (author_kind = 'member' and agent_name is null)
    or (author_kind = 'agent' and author_member_id is null and agent_name is not null)
  )
);
create function public.current_member_id(ws uuid) returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select m.id from public.member m where m.workspace_id = ws and m.user_id = auth.uid() limit 1
$$;
create function public.team_chat_can_read(ch uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.team_chat_channel c where c.id = ch and public.current_member_id(c.workspace_id) is not null)
$$;
create function public.team_chat_can_post(ch uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.team_chat_can_read(ch) and exists (select 1 from public.team_chat_channel c where c.id = ch and c.archived_at is null)
$$;
grant execute on function public.current_member_id(uuid) to authenticated;
grant execute on function public.team_chat_can_read(uuid) to authenticated;
grant execute on function public.team_chat_can_post(uuid) to authenticated;
create function public.team_chat_member_can_read(ch uuid, mem uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.team_chat_channel c join public.member m on m.id = mem and m.workspace_id = c.workspace_id where c.id = ch)
$$;
${fnIn(T564, 'team_chat_message_guard')}
create trigger team_chat_message_guard before update on public.team_chat_message for each row execute function public.team_chat_message_guard();
${fnIn(T555, 'team_chat_message_insert_guard')}
create trigger team_chat_message_insert_guard before insert on public.team_chat_message for each row execute function public.team_chat_message_insert_guard();
${fnIn(T474, 'team_chat_touch_channel')}
create trigger team_chat_touch_channel after insert on public.team_chat_message for each row execute function public.team_chat_touch_channel();
alter table public.team_chat_message enable row level security;
${slice(T474, 'create policy team_chat_message_select', ';')}
${slice(T564, 'create policy team_chat_message_insert', '\n  );')}
${slice(T474, 'create policy team_chat_message_update', '\n  );')}
grant usage on schema public to authenticated, service_role;
grant select, insert, update on table public.team_chat_message to authenticated;
grant select on table public.team_chat_channel to authenticated;
grant all on all tables in schema public to service_role;
`

const WS = '00000000-0000-4000-8000-000000000001'
const CHANNEL = '00000000-0000-4000-8000-000000000002'
const MEETING = '00000000-0000-4000-8000-000000000003'
const CALL = '00000000-0000-4000-8000-000000000004'
const ROSA = '00000000-0000-4000-8000-0000000000b1' // a member
const ROSA_USER = '00000000-0000-4000-8000-0000000000c1'
const DANA = '00000000-0000-4000-8000-0000000000a1' // let in, in the room
const LEE = '00000000-0000-4000-8000-0000000000a2' // waiting in the lobby
const SAM = '00000000-0000-4000-8000-0000000000a3' // let in, dropped off a moment ago
const RIO = '00000000-0000-4000-8000-0000000000a4' // let in, gone for minutes
const DIGEST = 'digest-of-the-link'

describe.skipIf(!PGlite)('migration 670 (run on PGlite)', () => {
  let db: Db
  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
  const post = async (guest: string, words: string, digest = DIGEST) =>
    (await one<{ v: { allowed: boolean; id?: string; created_at?: string; name?: string } }>('select public.meeting_guest_chat_post($1, $2, $3) as v', [guest, digest, words])).v
  const readChat = async (guest: string, max = 100) =>
    (await one<{ v: { allowed: boolean; messages: Array<{ id: string; author: string; label: string; mine: boolean; body: string; files: number; email: boolean }> } }>(
      'select public.meeting_guest_chat_read($1, $2, $3) as v',
      [guest, DIGEST, max],
    )).v
  /** Run as Rosa, signed in (the authenticated role, her user in the JWT), then back to the owner. */
  const asRosa = async <T>(sql: string, params: unknown[] = []): Promise<{ rows?: T[]; error?: string }> => {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${ROSA_USER}', false);`)
    try {
      return { rows: (await db.query<T>(sql, params)).rows }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`)
    }
  }

  beforeAll(async () => {
    db = new PGlite!()
    await db.exec(STAND_INS)
    await db.exec(`
      insert into public.member values ('${ROSA}', '${WS}', '${ROSA_USER}', 'Rosa Lind');
      insert into public.team_chat_channel (id, workspace_id, kind, name) values ('${CHANNEL}', '${WS}', 'meeting', 'Design review');
      insert into public.meeting values ('${MEETING}', '${CHANNEL}', '${DIGEST}', null);
      insert into public.team_call values ('${CALL}', '${CHANNEL}', 'live');
      -- Written before anyone came in: no guest reads it.
      insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at)
        values ('${CHANNEL}', '${WS}', '${ROSA}', 'Agenda before the call', now() - interval '10 minutes');
    `)
    // Twice: the file is re-runnable.
    await db.exec(SQL)
    await db.exec(SQL)
    await db.exec(`
      insert into public.meeting_guest (id, meeting_id, workspace_id, channel_id, name, state, call_id, in_call, first_joined_at, joined_at, left_at) values
        ('${DANA}', '${MEETING}', '${WS}', '${CHANNEL}', 'Dana Okafor', 'admitted', '${CALL}', true, now() - interval '5 minutes', now() - interval '1 minute', null),
        ('${LEE}', '${MEETING}', '${WS}', '${CHANNEL}', 'Lee Park', 'waiting', null, false, null, null, null),
        ('${SAM}', '${MEETING}', '${WS}', '${CHANNEL}', 'Sam Ruiz', 'admitted', '${CALL}', false, now() - interval '5 minutes', now() - interval '5 minutes', now() - interval '10 seconds'),
        ('${RIO}', '${MEETING}', '${WS}', '${CHANNEL}', 'Rio Chen', 'admitted', '${CALL}', false, now() - interval '5 minutes', now() - interval '5 minutes', now() - interval '3 minutes');
      insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at)
        values ('${CHANNEL}', '${WS}', '${ROSA}', 'Welcome, everyone', now() - interval '2 minutes');
      insert into public.team_chat_message (channel_id, workspace_id, author_kind, agent_for_member_id, agent_name, body, created_at, attachments)
        values ('${CHANNEL}', '${WS}', 'agent', '${ROSA}', 'Joseph', '', now() - interval '90 seconds', '[{"path":"x/y/z.pdf","name":"plan.pdf","size":1,"type":"application/pdf"}]');
      insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at, deleted_at)
        values ('${CHANNEL}', '${WS}', '${ROSA}', '', now() - interval '80 seconds', now());
      insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, created_at, kind, call_id)
        values ('${CHANNEL}', '${WS}', '${ROSA}', 'Started a call', now() - interval '70 seconds', 'call', '${CALL}');
    `)
  }, 60_000)

  it('the guest’s functions are definers with their search_path pinned, the service role’s alone', async () => {
    for (const name of ['meeting_guest_chat_post', 'meeting_guest_chat_read']) {
      const row = await one<{ definer: boolean; config: string[]; anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
        `select p.prosecdef as definer, p.proconfig as config,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as pub
           from pg_proc p where p.proname = $1`,
        [name],
      )
      expect(row.definer, name).toBe(true)
      expect(row.config, name).toContain('search_path=public, pg_temp')
      expect(row.anon || row.auth || row.pub, name).toBe(false)
      expect(row.svc, name).toBe(true)
    }
  })

  it('474’s column check is gone and the widened one stands, once', async () => {
    const checks = (await db.query<{ conname: string }>(`select conname from pg_constraint where conrelid = 'public.team_chat_message'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%author_kind%' order by conname`)).rows.map((r) => r.conname)
    expect(checks).toEqual(['team_chat_message_author', 'team_chat_message_author_kind'])
  })

  it('a guest let in and in the room posts: their name, trimmed words, a plain message; the conversation moves up the list', async () => {
    const before = (await one<{ at: string | null }>('select last_message_at as at from public.team_chat_channel where id = $1', [CHANNEL])).at
    const sent = await post(DANA, '   Hello from Dana  \n')
    expect(sent.allowed).toBe(true)
    expect(sent.name).toBe('Dana Okafor')
    const row = await one<Record<string, unknown>>('select * from public.team_chat_message where id = $1', [sent.id])
    expect(row).toMatchObject({ author_kind: 'guest', guest_id: DANA, guest_name: 'Dana Okafor', author_member_id: null, agent_name: null, agent_for_member_id: null, body: 'Hello from Dana', kind: 'message', mentions_agent: false, thread_root_id: null, link_preview: null })
    expect(row.attachments).toEqual([])
    expect(row.mentions).toEqual([])
    const after = (await one<{ at: string }>('select last_message_at as at from public.team_chat_channel where id = $1', [CHANNEL])).at
    expect(Date.parse(after)).toBeGreaterThan(before ? Date.parse(before) : 0)
  })

  it('refused: another link, a guest still waiting, one out of the room, words too long or empty, a call that ended, a revoked link', async () => {
    expect((await post(DANA, 'hi', 'another-digest')).allowed).toBe(false)
    expect((await post(LEE, 'hi')).allowed).toBe(false)
    expect((await post(SAM, 'hi')).allowed).toBe(false)
    await expect(post(DANA, 'x'.repeat(2001))).rejects.toThrow(/1 to 2000/)
    await expect(post(DANA, '   ')).rejects.toThrow(/1 to 2000/)
    expect((await post(DANA, 'x'.repeat(2000))).allowed).toBe(true)
    await db.query(`update public.team_call set status = 'ended' where id = $1`, [CALL])
    expect((await post(DANA, 'still there?')).allowed).toBe(false)
    expect((await readChat(DANA)).allowed).toBe(false)
    await db.query(`update public.team_call set status = 'live' where id = $1`, [CALL])
    await db.query(`update public.meeting set revoked_at = now() where id = $1`, [MEETING])
    expect((await post(DANA, 'still there?')).allowed).toBe(false)
    expect((await readChat(DANA)).allowed).toBe(false)
    await db.query(`update public.meeting set revoked_at = null where id = $1`, [MEETING])
  })

  it('reads the conversation since they first came in: no earlier message, no deleted one, no call’s row, no thread’s reply; labels and their own', async () => {
    const root = (await one<{ id: string }>(`select id from public.team_chat_message where body = 'Welcome, everyone'`)).id
    await db.query(`insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body, thread_root_id) values ($1, $2, $3, 'A thread reply', $4)`, [CHANNEL, WS, ROSA, root])
    const chat = await readChat(DANA)
    expect(chat.allowed).toBe(true)
    // No agent's reply (Joseph's file), no earlier message, no deleted one, no call's row, no thread's reply.
    expect(chat.messages.map((m) => [m.author, m.label, m.mine, m.body.slice(0, 20), m.files])).toEqual([
      ['member', 'Rosa Lind', false, 'Welcome, everyone', 0],
      ['guest', 'Dana Okafor', true, 'Hello from Dana', 0],
      ['guest', 'Dana Okafor', true, 'x'.repeat(20), 0],
    ])
    expect(JSON.stringify(chat)).not.toMatch(/Joseph|agent|x\/y\/z\.pdf|Agenda before the call|A thread reply|Started a call/)
    expect(Object.keys(chat.messages[0]).sort()).toEqual(['at', 'author', 'body', 'email', 'files', 'id', 'label', 'mine'])
    // The newest N, oldest first.
    expect((await readChat(DANA, 2)).messages.map((m) => m.author)).toEqual(['guest', 'guest'])
  })

  it('657’s grace: just dropped off, they read what was written before they left; gone for minutes, or never in, nothing', async () => {
    await db.query(`insert into public.team_chat_message (channel_id, workspace_id, author_member_id, body) values ($1, $2, $3, 'After Sam dropped')`, [CHANNEL, WS, ROSA])
    const sam = await readChat(SAM)
    expect(sam.allowed).toBe(true)
    expect(sam.messages.map((m) => m.body)).toContain('Welcome, everyone')
    expect(sam.messages.map((m) => m.body)).not.toContain('After Sam dropped')
    expect(sam.messages.every((m) => !m.mine)).toBe(true)
    expect((await readChat(RIO)).allowed).toBe(false)
    expect((await readChat(LEE)).allowed).toBe(false)
  })

  it('a signed-in member reads the guest’s message, and can neither forge one, nor edit one, nor put a guest on their own', async () => {
    const guestRow = (await one<{ id: string }>(`select id from public.team_chat_message where author_kind = 'guest' limit 1`)).id
    const seen = await asRosa<{ guest_name: string }>(`select guest_name from public.team_chat_message where id = $1`, [guestRow])
    expect(seen.rows).toEqual([{ guest_name: 'Dana Okafor' }])

    const forged = await asRosa(
      `insert into public.team_chat_message (channel_id, workspace_id, author_kind, guest_id, guest_name, body) values ($1, $2, 'guest', $3, 'Dana Okafor', 'Forged')`,
      [CHANNEL, WS, DANA],
    )
    expect(forged.error).toMatch(/row-level security/)
    const asMemberWithGuest = await asRosa(
      `insert into public.team_chat_message (channel_id, workspace_id, author_kind, author_member_id, guest_id, guest_name, body) values ($1, $2, 'member', $3, $4, 'Dana Okafor', 'Forged')`,
      [CHANNEL, WS, ROSA, DANA],
    )
    expect(asMemberWithGuest.error).toMatch(/team_chat_message_author/)

    const edited = await asRosa<{ id: string }>(`update public.team_chat_message set body = 'Edited by Rosa' where id = $1 returning id`, [guestRow])
    expect(edited.rows).toEqual([])
    const deleted = await asRosa<{ id: string }>(`update public.team_chat_message set deleted_at = now() where id = $1 returning id`, [guestRow])
    expect(deleted.rows).toEqual([])
    expect((await one<{ body: string; deleted_at: string | null }>('select body, deleted_at from public.team_chat_message where id = $1', [guestRow])).body).toBe('Hello from Dana')

    const own = (await one<{ id: string }>(`select id from public.team_chat_message where body = 'After Sam dropped'`)).id
    const named = await asRosa(`update public.team_chat_message set guest_name = 'Dana Okafor' where id = $1`, [own])
    expect(named.error).toMatch(/only the words of a message can change/)
    const turned = await asRosa(`update public.team_chat_message set author_kind = 'guest', author_member_id = null, guest_name = 'Dana Okafor' where id = $1`, [own])
    expect(turned.error).toBeDefined()
    // Her own words she may still edit, and she posts as before (the old code's insert).
    expect((await asRosa<{ id: string }>(`update public.team_chat_message set body = 'After Sam dropped off' where id = $1 returning id`, [own])).rows).toEqual([{ id: own }])
    const mine = await asRosa<{ author_kind: string }>(`insert into public.team_chat_message (channel_id, workspace_id, author_kind, author_member_id, body) values ($1, $2, 'member', $3, 'From Rosa') returning author_kind`, [CHANNEL, WS, ROSA])
    expect(mine.rows).toEqual([{ author_kind: 'member' }])
  })

  it('a member’s search never finds a guest’s message; a member’s it does', async () => {
    const guest = await asRosa<{ author_kind: string }>(`select author_kind from public.team_chat_search($1, 'hello dana', 8)`, [WS])
    expect(guest.rows).toEqual([])
    const member = await asRosa<{ author_kind: string; author_name: string }>(`select author_kind, author_name from public.team_chat_search($1, 'welcome everyone', 8)`, [WS])
    expect(member.rows).toEqual([{ author_kind: 'member', author_name: 'Rosa Lind' }])
  })

  it('a member who may read the conversation takes a guest’s message down, as a soft delete; nobody else, and never a member’s or an agent’s', async () => {
    const OUTSIDER = '00000000-0000-4000-8000-0000000000b2'
    await db.query(`insert into public.member values ($1, '00000000-0000-4000-8000-0000000000ff', null, 'Elsewhere')`, [OUTSIDER])
    const sent = await post(DANA, 'Please take this down')
    await db.query(`update public.team_chat_message set attachments = '[]'::jsonb, mentions = '{}' where id = $1`, [sent.id])
    const remove = async (message: string, member: string | null) =>
      (await one<{ v: boolean }>('select public.meeting_guest_chat_remove($1, $2) as v', [message, member])).v
    expect(await remove(sent.id!, OUTSIDER)).toBe(false)
    expect(await remove(sent.id!, null)).toBe(false)
    const memberMsg = (await one<{ id: string }>(`select id from public.team_chat_message where body = 'Welcome, everyone'`)).id
    const agentMsg = (await one<{ id: string }>(`select id from public.team_chat_message where author_kind = 'agent'`)).id
    expect(await remove(memberMsg, ROSA)).toBe(false)
    expect(await remove(agentMsg, ROSA)).toBe(false)
    expect(await remove(sent.id!, ROSA)).toBe(true)
    const row = await one<{ body: string; deleted_at: string | null; author_kind: string; guest_name: string }>('select body, deleted_at, author_kind, guest_name from public.team_chat_message where id = $1', [sent.id])
    expect(row.body).toBe('')
    expect(row.deleted_at).not.toBeNull()
    expect(row.guest_name).toBe('Dana Okafor')
    // Taken down once: a second try finds nothing to do, and the guest no longer reads it.
    expect(await remove(sent.id!, ROSA)).toBe(false)
    expect((await readChat(DANA)).messages.map((m) => m.id)).not.toContain(sent.id)
    expect((await one<{ body: string }>('select body from public.team_chat_message where id = $1', [memberMsg])).body).toBe('Welcome, everyone')
  })

  it('the guest’s row going sets its messages’ guest_id null, and the message keeps its name', async () => {
    await db.query(`delete from public.meeting_guest where id = $1`, [DANA])
    const rows = (await db.query<{ guest_id: string | null; guest_name: string }>(`select guest_id, guest_name from public.team_chat_message where author_kind = 'guest'`)).rows
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.guest_id === null && r.guest_name === 'Dana Okafor')).toBe(true)
  })
})
