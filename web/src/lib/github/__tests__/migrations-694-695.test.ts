/**
 * Migrations 694 (pull-request automation) and 695 (GitHub notices),
 * docs/plans/github-reviews.md: each its own transaction, the only file of
 * its number; 695's notification lists are the app's, and the newest word.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOTIFICATION_TYPES } from '@/lib/notifications'

const DIR = join(process.cwd(), 'supabase/migrations')
const read = (f: string) => readFileSync(join(DIR, f), 'utf8')
const code = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
const list = (sql: string, check: string) => {
  const at = sql.indexOf(`add constraint ${check} check`)
  const body = sql.slice(at, sql.indexOf(')) not valid', at))
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

describe('migrations 694 and 695', () => {
  for (const f of ['694_github_reviews.sql', '695_github_notifications.sql']) {
    it(`${f}: the only one of its number, its own begin/commit`, () => {
      const n = f.split('_')[0]
      expect(readdirSync(DIR).filter((x) => x.startsWith(`${n}_`))).toEqual([f])
      const c = code(read(f)).trim()
      expect(c.startsWith('begin;')).toBe(true)
      expect(c.endsWith('commit;')).toBe(true)
    })
  }

  it('694: RLS on every new table, no client writes to the automation’s tables', () => {
    const c = code(read('694_github_reviews.sql'))
    for (const t of ['github_identity', 'workspace_github_repo', 'action_github_branch']) expect(c).toContain(`alter table public.${t} enable row level security;`)
    expect(c).toContain('revoke insert, update, delete on table public.github_identity from authenticated, anon;')
    expect(c).toContain('revoke insert, update, delete on table public.action_github_branch from authenticated, anon;')
    expect(c).toContain('before insert or update on public.action_github_pr')
  })

  it('695: the type check is exactly the app’s types, and the target check takes github_pr', () => {
    const c = code(read('695_github_notifications.sql'))
    expect(list(c, 'notification_type_check')).toEqual([...NOTIFICATION_TYPES])
    expect(list(c, 'notification_target_type_check')).toContain('github_pr')
    expect(c).toContain('alter table public.github_pull_request enable row level security;')
    expect(c).not.toMatch(/create policy/i)
  })
})
