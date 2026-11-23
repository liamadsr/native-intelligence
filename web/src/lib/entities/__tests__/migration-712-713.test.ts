/**
 * Migrations 712 and 713: Recent's indexes and its direct read
 * (docs/plans/recent-panel.md, phase 2). TEXT CHECKS here.
 *
 * By hand, outside this suite, both files were applied twice on a local
 * Postgres 16 with stand-ins for the tables they read (auth.uid() read from a
 * setting; 474/572's team_chat_can_read, 359's current_member_id, owner-only
 * chat rules), 712 without --single-transaction and 713 with it, and asked as
 * two members of one workspace: A got A's DM, channels, private doc,
 * spreadsheet, canvas and non-home chat, never B's; B got the channels B
 * reacted and voted in and B's team channel, never A's DM; once B left that
 * team its channel dropped out; a deleted message, an inactive reaction, the
 * home thread and an outside channel's thread never counted; another
 * workspace answered nothing; anon was refused.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8')
const I = read('712_recent_indexes.sql')
const F = read('713_my_recent_work.sql')
/** The SQL without its comments. */
const code = (sql: string) => sql.replace(/--[^\n]*/g, '')

describe('712: indexes only, built without blocking writes', () => {
  it('every index is CONCURRENTLY and IF NOT EXISTS, and the file has no transaction of its own', () => {
    const creates = code(I).match(/create\s+(unique\s+)?index[^;]*/gi) ?? []
    expect(creates).toHaveLength(6)
    for (const c of creates) expect(c).toMatch(/^create index concurrently if not exists /i)
    expect(code(I)).not.toMatch(/\bbegin\b|\bcommit\b/i)
    // Nothing else: no table, column, policy, grant or function.
    expect(code(I)).not.toMatch(/create (table|policy|function|or replace)|alter table|grant |revoke /i)
    expect(I).toMatch(/WITHOUT --single-transaction/)
    expect(I).toMatch(/INVALID/)
  })
})

describe('713: my_recent_work answers only the caller’s own work, under their RLS', () => {
  const body = code(F)
  it('is SECURITY INVOKER, stable, with a pinned search_path, and takes no member or user argument', () => {
    expect(body).toMatch(/create or replace function public\.my_recent_work\(p_workspace uuid, p_since timestamptz, p_limit integer default 50\)/)
    expect(body).toMatch(/security invoker/)
    expect(body).not.toMatch(/security definer/)
    expect(body).toMatch(/set search_path = public, pg_temp/)
    expect(body).toMatch(/public\.current_member_id\(p_workspace\) as member_id, auth\.uid\(\) as user_id/)
  })

  it('is refused to anon, and re-checks a channel with team_chat_can_read', () => {
    expect(body).toMatch(/revoke all on function public\.my_recent_work\(uuid, timestamptz, integer\) from public, anon;/)
    expect(body).toMatch(/grant execute on function public\.my_recent_work\(uuid, timestamptz, integer\) to authenticated, service_role;/)
    expect(body).toMatch(/where public\.team_chat_can_read\(t\.channel_id\)/)
  })

  it('counts a member’s live messages, active reactions and votes; never the home thread, a meeting’s or an outside channel’s chat', () => {
    expect(body).toMatch(/m\.author_kind = 'member'\s+and m\.deleted_at is null/)
    expect(body).toMatch(/and r\.active/)
    expect(body).toMatch(/public\.team_chat_poll_vote v/)
    expect(body).toMatch(/c\.is_home is not true\s+and c\.capture_id is null\s+and c\.outside_channel is null/)
    expect(body).toMatch(/least\(greatest\(coalesce\(p_limit, 50\), 1\), 100\)/)
  })

  it('its own transaction, a bounded lock wait, and the schema reload', () => {
    expect(body).toMatch(/^\s*begin;/m)
    expect(body).toMatch(/set local lock_timeout = '5s';/)
    expect(body).toMatch(/commit;\s*notify pgrst, 'reload schema';\s*$/)
  })
})

describe('my_recent_work, as the database ends up with it (its newest definition, in any later migration too)', () => {
  // The newest file that (re)defines it, in either letter case (lib's definitionsIn reads upper case only).
  const latest = (() => {
    const head = /create\s+or\s+replace\s+function\s+public\.my_recent_work\s*\(/gi
    const files = migrationsInOrder()
    for (let i = files.length - 1; i >= 0; i--) {
      const sql = files[i].sql.replace(/--[^\n]*/g, '')
      const blocks: string[] = []
      for (const m of sql.matchAll(head)) {
        const open = sql.indexOf('$$', m.index)
        const close = sql.indexOf('$$', open + 2)
        const semi = sql.indexOf(';', close + 2)
        blocks.push(sql.slice(m.index, semi + 1))
      }
      if (blocks.length) return { file: files[i].file, blocks }
    }
    return { file: '(none)', blocks: [] as string[] }
  })()
  it('still takes no user or member argument: "me" is only ever the session’s own', () => {
    expect(latest.blocks.length).toBeGreaterThan(0)
    for (const block of latest.blocks) {
      const args = /function\s+public\.my_recent_work\s*\(([^)]*)\)/i.exec(block)?.[1] ?? ''
      expect(args.replace(/\s+/g, ' ').trim(), latest.file).toBe('p_workspace uuid, p_since timestamptz, p_limit integer default 50')
      const names = args.split(',').map((a) => a.trim().split(/\s+/)[0])
      for (const n of names) expect(n, latest.file).not.toMatch(/user|member|uid|actor|person/i)
    }
  })

  it('is still SECURITY INVOKER, never DEFINER', () => {
    for (const block of latest.blocks) {
      const sql = block.replace(/--[^\n]*/g, '')
      expect(sql, latest.file).toMatch(/security invoker/i)
      expect(sql, latest.file).not.toMatch(/security definer/i)
    }
  })
})
