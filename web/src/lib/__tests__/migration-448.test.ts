/**
 * Migration 448: has_active_share_for_commentable (088, rebuilt by 447) is
 * SECURITY DEFINER, and on PROD PUBLIC and anon could still execute it. 448
 * revokes both and keeps `authenticated` (the comment insert policy runs as
 * the caller and calls it) and service_role, matching DEV.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(process.cwd(), 'supabase/migrations')
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')
const SQL = read('448_share_comment_check_grants.sql')
const flat = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
const BODY = flat(SQL)
/** BODY with its string literals emptied, so words in messages don't count as statements. */
const CODE = BODY.replace(/'(?:[^']|'')*'/g, "''")

const FN = 'public.has_active_share_for_commentable(public.commentable_type, uuid)'

describe('migration 448', () => {
  it('has no backslash', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('revokes PUBLIC and anon and grants authenticated and service_role, by the exact signature', () => {
    expect(BODY).toContain(`revoke execute on function ${FN} from public, anon;`)
    expect(BODY).toContain(`grant execute on function ${FN} to authenticated, service_role;`)
  })

  it('never revokes authenticated, which the comment insert policy runs as', () => {
    expect(BODY).not.toMatch(/revoke [^;]*from [^;]*authenticated/)
  })

  it('touches no other object', () => {
    expect(CODE).not.toMatch(/create (or replace )?(function|policy|trigger|table)/)
    expect(CODE).not.toMatch(/\b(drop|alter|update|delete|insert)\b/)
    expect(CODE.match(/\b(revoke|grant)\b/g) ?? []).toHaveLength(2)
    const statements = BODY.match(/\b(revoke|grant) execute on function [^;]+;/g) ?? []
    expect(statements).toHaveLength(2)
    for (const s of statements) expect(s).toContain(FN)
  })

  it('checks the function exists first and the grants after', () => {
    expect(BODY.indexOf(`to_regprocedure('${FN}') is null`)).toBeGreaterThan(-1)
    expect(BODY.indexOf(`to_regprocedure('${FN}')`)).toBeLessThan(BODY.indexOf('revoke execute'))
    const post = BODY.slice(BODY.indexOf('grant execute'))
    expect(post).toContain("if has_function_privilege('anon', fn, 'execute') then raise exception")
    expect(post).toContain("if not has_function_privilege('authenticated', fn, 'execute') then raise exception")
  })

  it('is the only migration after 447 that changes this function or its grants', () => {
    const later = readdirSync(DIR).filter((f) => /^\d+_.*\.sql$/.test(f) && Number.parseInt(f, 10) > 447)
    const changes = [
      /\b(grant|revoke)\b[^;]* on function public\.has_active_share_for_commentable\b/,
      /create (or replace )?function public\.has_active_share_for_commentable\b/,
      /\b(drop|alter) function [^;]*has_active_share_for_commentable\b/,
    ]
    for (const f of later) {
      if (f === '448_share_comment_check_grants.sql') continue
      const body = flat(read(f))
      for (const change of changes) expect(body, f).not.toMatch(change)
    }
  })
})
