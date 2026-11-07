/**
 * The validators the routes share with migration 420's CHECKs (and, in E3,
 * Rust): a base branch is a plain local branch name, a linked repo is
 * owner/repo, and a Mac's environment name follows its device's. The SQL
 * patterns are read from the migration and run here against the same cases,
 * so the two can't drift.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASE_BRANCH_FORBIDDEN_RE,
  BASE_BRANCH_RE,
  ENVIRONMENT_NAME_MAX,
  MAC_ENVIRONMENT_FALLBACK_NAME,
  REPO_FULL_NAME_RE,
  clipChars,
  isBaseBranch,
  isNetworkAccess,
  isRepoFullName,
  macEnvironmentName,
} from '../types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/420_environments.sql'), 'utf8')

/** The migration's patterns, as Postgres runs them (POSIX: these are JS-compatible). */
function sqlPattern(re: RegExp): RegExp {
  const m = re.exec(SQL)
  if (!m) throw new Error(`pattern not found: ${re}`)
  return new RegExp(m[1])
}
const SQL_BRANCH = sqlPattern(/base_branch ~ '([^']+)'/)
const SQL_BRANCH_FORBIDDEN = sqlPattern(/base_branch !~ '([^']+)'/)
const SQL_REPO = sqlPattern(/repo_full_name ~ '([^']+)'/)

const sqlBranch = (s: string) => SQL_BRANCH.test(s) && !SQL_BRANCH_FORBIDDEN.test(s)
/** A pattern's text, with JS's escaped slashes as Postgres writes them. */
const text = (re: RegExp) => re.source.split('\\/').join('/')

const BRANCHES: Array<[string, boolean]> = [
  ['main', true],
  ['release/2026-10', true],
  ['feature/a.b_c-d', true],
  ['v1.0', true], // a name; the Mac resolves only refs/heads/<name> (E3), never a tag
  // A ref name is never a branch name here (Rust refuses the same): only the plain name is.
  ['refs/remotes/origin/main', false],
  ['refs/heads/main', false],
  ['HEAD', false],
  ['HEADS', true],
  ['feature/HEAD', true],
  ['x'.repeat(100), true],
  ['x'.repeat(101), false],
  ['@{-1}', false],
  ['HEAD~1', false],
  ['HEAD^', false],
  ['--upload-pack=touch x', false],
  ['-x', false],
  ['a..b', false],
  ['a//b', false],
  ['main.lock', false],
  ['main/', false],
  ['main.', false],
  ['.hidden', false],
  ['/abs', false],
  ['two words', false],
  ['main:other', false],
  ['', false],
]

const REPOS: Array<[string, boolean]> = [
  ['dial8/website', true],
  ['a-b/c.d_e', true],
  ['x'.repeat(39) + '/r', true],
  ['x'.repeat(40) + '/r', false],
  ['dial8', false],
  ['a/b/c', false],
  ['https://github.com/a/b', false],
  ['a_b/c', false],
  ['a/' + 'r'.repeat(101), false],
]

describe('the base branch pattern', () => {
  it.each(BRANCHES)('%s → %s, in code and in the migration alike', (name, ok) => {
    expect(isBaseBranch(name)).toBe(ok)
    expect(sqlBranch(name)).toBe(ok)
  })

  it('is the same pattern text in both', () => {
    expect(text(SQL_BRANCH)).toBe(text(BASE_BRANCH_RE))
    expect(text(SQL_BRANCH_FORBIDDEN)).toBe(text(BASE_BRANCH_FORBIDDEN_RE))
  })
})

describe('the linked repo pattern', () => {
  it.each(REPOS)('%s → %s, in code and in the migration alike', (name, ok) => {
    expect(isRepoFullName(name)).toBe(ok)
    expect(SQL_REPO.test(name)).toBe(ok)
  })

  it('is the same pattern text in both', () => {
    expect(text(SQL_REPO)).toBe(text(REPO_FULL_NAME_RE))
  })
})

describe('names', () => {
  it('a Mac’s environment is named after it: trimmed, the migration’s fallback when empty, at most 80 characters', () => {
    expect(macEnvironmentName('  Liam’s MacBook Pro ')).toBe('Liam’s MacBook Pro')
    expect(macEnvironmentName('')).toBe(MAC_ENVIRONMENT_FALLBACK_NAME)
    expect(macEnvironmentName(null)).toBe(MAC_ENVIRONMENT_FALLBACK_NAME)
    expect(macEnvironmentName('m'.repeat(200))).toHaveLength(ENVIRONMENT_NAME_MAX)
    expect(SQL).toContain(
      `left(coalesce(nullif(btrim(d.name, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13)), ''), '${MAC_ENVIRONMENT_FALLBACK_NAME}'), ${ENVIRONMENT_NAME_MAX})`,
    )
    expect(SQL).toContain(`check (char_length(name) between 1 and ${ENVIRONMENT_NAME_MAX})`)
  })

  it('trims the same six characters as the migration’s btrim (chr 9 to 13, and space), and nothing else', () => {
    // What Postgres' btrim(name, ' ' || chr(9) || … || chr(13)) does, in JS.
    const set = [' ', ...[9, 10, 11, 12, 13].map((c) => String.fromCharCode(c))]
    const sqlTrim = (v: string) => {
      let a = 0
      let b = v.length
      while (a < b && set.includes(v[a])) a++
      while (b > a && set.includes(v[b - 1])) b--
      return v.slice(a, b)
    }
    for (const name of [' Mac ', '\t\nStudio\r\n', '\u000bMac\u000c', '\u00a0Mac\u00a0', '\u2003Mac', 'Mac Pro', '\n\t ']) {
      expect(macEnvironmentName(name)).toBe(sqlTrim(name) || MAC_ENVIRONMENT_FALLBACK_NAME)
    }
  })

  it('clips by character, never through a surrogate pair', () => {
    expect(clipChars('🙂🙂🙂', 2)).toBe('🙂🙂')
    expect(Array.from(macEnvironmentName('🙂'.repeat(90)))).toHaveLength(ENVIRONMENT_NAME_MAX)
  })

  it('network levels are the three the sandbox knows', () => {
    expect(['trusted', 'restricted', 'isolated'].every(isNetworkAccess)).toBe(true)
    expect(isNetworkAccess('open')).toBe(false)
    expect(SQL).toContain("network_access text check (network_access in ('trusted', 'restricted', 'isolated'))")
  })
})
