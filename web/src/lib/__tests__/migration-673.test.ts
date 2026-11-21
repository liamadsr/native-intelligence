import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The app comments on five kinds of record; the comment table's row policies
// must each have a branch for every kind. A CASE with no branch for a kind is
// null, and the database then refuses that kind's comments outright (what
// 088 and 493 did to projects and contacts until 673).
const MIGRATIONS = join(process.cwd(), 'supabase/migrations')
const sql = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '')
const kindsIn = (text: string) => [...new Set([...text.matchAll(/when\s+'([a-z_]+)'/gi)].map((m) => m[1]))].sort()

/** One `create policy` statement on public.comment, by name. */
function policy(file: string, name: string): string {
  const text = sql(file)
  const start = text.search(new RegExp(`create\\s+policy\\s+"?${name}"?\\s+on\\s+public\\.comment`, 'i'))
  expect(start, `${file} creates ${name}`).toBeGreaterThanOrEqual(0)
  return text.slice(start, text.indexOf(';', start))
}

function commentableTypes(): string[] {
  const source = readFileSync(join(process.cwd(), 'src/lib/comments.ts'), 'utf8')
  const line = source.match(/export type CommentableType = ([^\n]+)/)?.[1] ?? ''
  return [...line.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
}

describe('migration 673: comments on a project and a contact', () => {
  const file = '673_comment_project_contact_policies.sql'

  it('carries no transaction of its own, so --single-transaction and a rolled-back rehearsal both hold', () => {
    expect(sql(file)).not.toMatch(/^\s*(begin|commit)\s*;/im)
  })

  it.each([
    ['comment_project_contact_select', 'for select'],
    ['comment_project_contact_insert', 'for insert'],
    ['comment_project_contact_resolve', 'for update'],
  ])('%s covers both kinds, and no other kind passes it', (name, verb) => {
    const text = policy(file, name)
    expect(text.toLowerCase()).toContain(verb)
    expect(kindsIn(text)).toEqual(['contact', 'project'])
    expect(text).toMatch(/else\s+false/i)
    // Dropped first, so running the file twice is safe.
    expect(sql(file)).toMatch(new RegExp(`drop policy if exists ${name} on public\\.comment`, 'i'))
  })

  it('a new comment is written as the caller’s own member of the record’s workspace', () => {
    const text = policy(file, 'comment_project_contact_insert')
    expect(text).toMatch(/author_user_id is null/i)
    expect(text.match(/m\.id = comment\.author_id/g)).toHaveLength(2)
    expect(text.match(/m\.user_id = auth\.uid\(\)/g)).toHaveLength(2)
    expect(text.match(/m\.workspace_id = [pc]\.workspace_id/g)).toHaveLength(2)
  })

  it('together with the policies it stands beside, every kind the app comments on can be viewed, written and resolved', () => {
    const wanted = commentableTypes()
    expect(wanted).toEqual(['action', 'capture', 'contact', 'document', 'project'])
    const view = [...kindsIn(policy('493_entity_access_read_policies.sql', 'View comments: members \\+ own external')), ...kindsIn(policy(file, 'comment_project_contact_select'))].sort()
    const write = [...kindsIn(policy('088_external_commenters.sql', 'Create comments: members or external via share')), ...kindsIn(policy(file, 'comment_project_contact_insert'))].sort()
    const resolve = [...kindsIn(policy('088_external_commenters.sql', 'Members can resolve comments on their entities')), ...kindsIn(policy(file, 'comment_project_contact_resolve'))].sort()
    expect(view).toEqual(wanted)
    expect(write).toEqual(wanted)
    expect(resolve).toEqual(wanted)
  })

  it('no later migration replaces the policies it relies on without this test being looked at', () => {
    const later = readdirSync(MIGRATIONS).filter((name) => Number.parseInt(name, 10) > 673)
    for (const name of later) {
      expect(sql(name), `${name} redefines a comment policy: check every kind still has a branch`).not.toMatch(/create\s+policy\s+[^;]*on\s+public\.comment\b/i)
    }
  })
})
