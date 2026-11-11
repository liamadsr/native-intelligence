/**
 * Migrations 572-575 (meeting links). Each is one transaction whatever
 * applies it, safe on a live database, and reloads the API schema; the new
 * tables have RLS on and anon has nothing; a guest's key and the limits are
 * the service role's alone; the token's hash is no client's to read; every
 * function is a definer with a pinned search_path; the functions they
 * redefine are named, each changed only where it says; none of 568's are
 * touched. Run on DEV by supabase/tests/572_meeting_links.sql (rolled back);
 * this pins the files' text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { NOTIFICATION_TYPES } from '@/lib/notifications'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const flat = (sql: string) => bodyOf(sql).replace(/\s+/g, ' ')

const FILES = {
  conversations: read('572_meeting_conversations.sql'),
  tables: read('573_meeting_links.sql'),
  functions: read('574_meeting_functions.sql'),
  counts: read('575_team_call_guest_counts.sql'),
}
const CALLS = read('565_team_call_functions.sql')

const defined = (sql: string) => [...bodyOf(sql).matchAll(/create or replace function public\.(\w+)\(/gi)].map((m) => m[1])

describe('migrations 572-575', () => {
  it('each is one transaction whatever applies it, safe for a live database, and reloads the API schema', () => {
    for (const [name, sql] of Object.entries(FILES)) {
      const body = bodyOf(sql)
      expect(sql, name).not.toContain('\\')
      expect(body, name).toMatch(/^\s*begin;\s*SET LOCAL lock_timeout = '5s';/)
      expect(body.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;"), name).toBe(true)
      expect((body.match(/^(begin|commit);$/gm) ?? []).length, name).toBe(2)
      expect(body, name).not.toMatch(/concurrently|vacuum/i)
      expect(body, name).not.toMatch(/drop table|delete from|truncate|drop column|drop function/i)
      expect(body, name).not.toMatch(/to anon/)
      expect(body, name).not.toMatch(/create (unique )?index (?!if not exists)/)
      expect(body, name).not.toMatch(/add column (?!if not exists)/)
      expect(body, name).not.toMatch(/create table (?!if not exists)/)
      for (const [, c] of body.matchAll(/add constraint (\w+)/g)) {
        expect(body, c).toContain(`drop constraint if exists ${c};`)
        expect(body, c).toMatch(new RegExp(`add constraint ${c} [\\s\\S]*? not valid;`))
        expect(body, c).toContain(`validate constraint ${c};`)
      }
    }
  })

  it('572 redefines exactly the nine readers it names, each only to read a meeting’s members as a DM’s', () => {
    expect(defined(FILES.conversations).sort()).toEqual(
      [
        'entity_edit_grant_reaches',
        'entity_grant_ids_for',
        'entity_grant_reaches',
        'entity_visible_to',
        'entity_visible_to',
        'my_entity_edit_grant_ids',
        'my_entity_grant_ids',
        'team_chat_can_read',
        'team_chat_member_can_read',
      ].sort(),
    )
    const body = bodyOf(FILES.conversations)
    expect(body).not.toMatch(/(c|v_)\.?kind = 'dm'/)
    expect((body.match(/kind in \('dm', 'meeting'\)/g) ?? []).length).toBe(9)
    // 568's owner-arm functions are never redefined here.
    for (const fn of ['capture_visible_to', 'claim_visible_to', 'unified_search', 'hybrid_search']) {
      for (const sql of Object.values(FILES)) expect(bodyOf(sql)).not.toContain(`function public.${fn}(`)
    }
  })

  it('575 redefines three of 565’s functions from their current bodies, changing only the count', () => {
    const theirs = (name: string) => {
      const i = CALLS.indexOf(`create or replace function public.${name}(`)
      return CALLS.slice(i, CALLS.indexOf('\n$$;\n', i) + 5)
    }
    const ours = (name: string) => {
      const i = FILES.counts.indexOf(`create or replace function public.${name}(`)
      return FILES.counts.slice(i, FILES.counts.indexOf('\n$$;\n', i) + 5)
    }
    expect(defined(FILES.counts)).toEqual(['team_call_participant_event', 'team_call_fence', 'team_call_member_gone_trigger'])
    for (const fn of defined(FILES.counts)) {
      const a = theirs(fn).split('\n')
      const b = ours(fn).split('\n')
      const removed = a.filter((l) => !b.includes(l))
      const added = b.filter((l) => !a.includes(l))
      expect(removed.length, fn).toBe(1)
      expect(removed[0], fn).toMatch(/count\(\*\)::integer/)
      expect(added.join('\n'), fn).toMatch(/team_call_people_now\((c|t)\.id\)/)
    }
    // 574 defines none of 565's.
    for (const fn of defined(CALLS)) expect(bodyOf(FILES.functions), fn).not.toContain(`function public.${fn}(`)
  })

  it('the tables: RLS on, members read a meeting (never its token’s hash) and its guests, the key and the limits are the service role’s', () => {
    const body = flat(FILES.tables)
    for (const t of ['meeting', 'meeting_guest', 'meeting_guest_key', 'meeting_rate']) {
      expect(body).toContain(`alter table public.${t} enable row level security;`)
      expect(body).toContain(`revoke all on table public.${t} from anon, authenticated;`)
    }
    expect(body).toMatch(/grant select \(id, workspace_id, channel_id, host_member_id, title, starts_at, ends_at, opens_at, closes_at, revoked_at, revoked_by, created_at\) on table public\.meeting to authenticated;/)
    expect(body).toContain('grant select on table public.meeting_guest to authenticated;')
    expect(body).not.toMatch(/on table public\.meeting_guest_key to authenticated/)
    expect(body).not.toMatch(/on table public\.meeting_rate to authenticated/)
    expect(body).toContain('using (public.team_chat_can_read(channel_id))')
    // Nothing the app writes is deleted from the published table.
    expect(body).toContain('alter publication supabase_realtime add table public.meeting_guest;')
    expect(body).not.toMatch(/publication supabase_realtime add table public\.meeting_(rate|guest_key);/)
  })

  it('every function: a definer with a pinned search_path, revoked from public and anon; person functions to authenticated, the rest to the service role', () => {
    const body = bodyOf(FILES.functions)
    const fns = defined(FILES.functions)
    expect(fns.length).toBeGreaterThan(12)
    for (const fn of fns) {
      const i = body.indexOf(`function public.${fn}(`)
      const head = body.slice(i, body.indexOf('as $$', i))
      expect(head, fn).toContain('security definer')
      expect(head, fn).toContain('set search_path = public, pg_temp')
      expect(body, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon`))
    }
    const person = ['meeting_create', 'meeting_join', 'meeting_revoke', 'meeting_guest_decide', 'meeting_guest_remove']
    const granted = [...body.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to authenticated;/g)].map((m) => m[1])
    expect(granted.sort()).toEqual([...person].sort())
    expect(body).toMatch(/revoke all on function public\.meeting_make\([^)]*\) from public, anon, authenticated;/)
    expect(body).not.toMatch(/grant execute on function public\.meeting_make/)
  })

  it('572: a meeting’s conversation is its own kind, its notice a notification type the app knows; the newest word on both checks', () => {
    const body = flat(FILES.conversations)
    const types = [...(/notification_type_check check \(type = any \(array\[([^\]]*)\]\)\)/.exec(body)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((v) => v[1])
    expect(types).toEqual([...NOTIFICATION_TYPES])
    const newest = (re: RegExp) => [...migrationsInOrder()].reverse().find((m) => re.test(m.sql))!.file
    expect(newest(/add constraint notification_type_check/i)).toBe('572_meeting_conversations.sql')
    expect(newest(/add constraint notification_target_type_check/i)).toBe('572_meeting_conversations.sql')
    expect(body).toContain("check (kind in ('channel', 'dm', 'meeting'))")
    expect(body).toContain("(kind = 'meeting' and name is not null and char_length(name) between 1 and 80 and dm_key is null and team_id is null)")
    expect(body).toContain("'meeting_waiting'")
    expect(body).toContain("'team_chat_channel'")
  })
})
