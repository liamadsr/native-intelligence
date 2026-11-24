/**
 * Migration 719 (support chat for existing accounts), read as text: the
 * owner's switch and the existing accounts' welcome, and the two functions it
 * restates from 715's text with exactly one change each.
 *
 * Rehearsed on a local Postgres 16 (the same stand-ins as 715's): 715, then
 * 719 applied twice over three accounts from before it; 14 checks passed (the
 * switch on by default and the welcome seeded; nothing started in a burst and
 * nobody notified; staff out; switch off means 715's rule; on, an account
 * from before gets one, once, with its welcome and mention; a new sign-up
 * still gets the new-account welcome; an empty existing welcome falls back;
 * one who deleted theirs is not restarted by coming back, only by an admin).
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const ALL = migrationsInOrder()
const SQL = ALL.find((m) => m.file === '719_support_chat_existing.sql')?.sql ?? ''
const SQL715 = ALL.find((m) => m.file === '715_support_chat.sql')?.sql ?? ''

function blocksIn(sql: string, fn: string): string[] {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, 'gi')
  const out: string[] = []
  for (const m of sql.matchAll(re)) {
    const start = m.index ?? 0
    const tag = /\$(\w*)\$/.exec(sql.slice(start))
    if (!tag) continue
    const open = start + (tag.index ?? 0)
    const close = sql.indexOf(tag[0], open + tag[0].length)
    out.push(sql.slice(start, sql.indexOf(';', close + tag[0].length) + 1))
  }
  return out
}

const flat = (s: string) => s.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim()

describe('migration 719: the file', () => {
  it('is one transaction under lock_timeout, says how to apply it, reloads the API schema last, has no backslash', () => {
    expect(SQL).toMatch(/^begin;$/m)
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';")
    expect(SQL.trimEnd()).toMatch(/notify pgrst, 'reload schema';\s*commit;$/)
    expect(SQL).toContain('psql -v ON_ERROR_STOP=1 < 719_support_chat_existing.sql')
    expect(SQL).not.toContain('\\')
  })

  it('adds the switch (on by default) and the existing accounts’ welcome, seeded once', () => {
    expect(SQL).toContain('add column if not exists existing_accounts boolean not null default true')
    expect(SQL).toContain('add column if not exists welcome_existing_template text;')
    expect(SQL).toContain("where id and welcome_existing_template is null;")
  })

  it('keeps both functions definers with search_path pinned, the service role’s alone', () => {
    for (const [fn, args] of [
      ['support_chat_start', 'uuid, boolean'],
      ['support_chat_start_if_due', 'uuid'],
    ]) {
      const blocks = blocksIn(SQL, fn)
      expect(blocks, fn).toHaveLength(1)
      expect(flat(blocks[0])).toContain('security definer set search_path = public, pg_temp')
      expect(SQL).toContain(`revoke all on function public.${fn}(${args}) from public, anon, authenticated;`)
      expect(SQL).toContain(`grant execute on function public.${fn}(${args}) to service_role;`)
    }
  })
})

describe('migration 719: each restatement is 715’s text plus exactly one change', () => {
  it('support_chat_start: the existing accounts’ welcome for an account from before starts_from', () => {
    const prior = flat(blocksIn(SQL715, 'support_chat_start')[0])
    const from = 'select st.welcome_template into template from public.support_chat_settings st where st.id;'
    expect(prior).toContain(from)
    const to =
      "select case when u.created_at < st.starts_from and nullif(btrim(st.welcome_existing_template), '') is not null then st.welcome_existing_template else st.welcome_template end into template from public.support_chat_settings st, auth.users u where st.id and u.id = p_user;"
    expect(flat(blocksIn(SQL, 'support_chat_start')[0])).toBe(prior.replace(from, to))
  })

  it('support_chat_start_if_due: due while the switch is on, as well as for accounts made since', () => {
    const prior = flat(blocksIn(SQL715, 'support_chat_start_if_due')[0])
    const from = 'and u.created_at >= st.starts_from'
    expect(prior).toContain(from)
    expect(flat(blocksIn(SQL, 'support_chat_start_if_due')[0])).toBe(prior.replace(from, 'and (u.created_at >= st.starts_from or st.existing_accounts)'))
  })

  it('both are now 719’s, and nothing before 719 but 715 defined them', () => {
    for (const fn of ['support_chat_start', 'support_chat_start_if_due']) {
      const files = ALL.filter((m) => blocksIn(m.sql, fn).length).map((m) => m.file)
      expect(files, fn).toEqual(['715_support_chat.sql', '719_support_chat_existing.sql'])
    }
  })

  it('staff and deleted ones stay out (715’s checks are kept word for word)', () => {
    const start = flat(blocksIn(SQL, 'support_chat_start')[0])
    expect(start).toContain("if exists (select 1 from public.support_staff s where s.user_id = p_user) then return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'staff');")
    expect(start).toContain("if not coalesce(p_fresh, false) then return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'deleted');")
  })
})
