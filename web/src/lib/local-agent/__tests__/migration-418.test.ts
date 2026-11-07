/**
 * Migration 418 (teammate plan, WS-C): the columns only, additive, safe for
 * the code running before it (applied before the deploy). The index is 419.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PERSON_WORDS_MAX } from '../store'
import { PR_URL_MAX } from '../pull-request'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/418_local_agent_teammate.sql'), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 418', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('adds the two columns idempotently, with safe defaults; a pull request is a github.com URL', () => {
    expect(BODY).toContain('add column if not exists local_model boolean not null default false')
    expect(BODY).toContain('add column if not exists pr_url text constraint local_agent_session_pr_url_ck')
    expect(BODY).toContain(`char_length(pr_url) between 20 and ${PR_URL_MAX}`)
    expect(BODY).toContain("pr_url like 'https://github.com/%'")
  })

  it('keeps the person’s words (the reviewer’s evidence) on the session and the message, at most 3', () => {
    for (const [t, c] of [['local_agent_session', 'start_words'], ['local_agent_message', 'person_words']]) {
      expect(BODY).toContain(`alter table public.${t} add column if not exists ${c} text[] constraint ${t}_${c}_ck check (${c} is null or cardinality(${c}) <= 3)`)
    }
    expect(PERSON_WORDS_MAX).toBe(3)
  })

  it('says it is a hard prerequisite of the claim change (the claim fails closed without it)', () => {
    expect(SQL).toContain('HARD PREREQUISITE')
  })

  it('holds the columns only: no index, no row written, no lock (safe for the code running before it)', () => {
    expect(BODY).not.toMatch(/create (unique )?index/)
    expect(BODY).not.toMatch(/\b(update public|insert into|delete from|lock table|create policy|drop policy|alter policy)\b/i)
    expect(SQL).toContain('apply it BEFORE the deploy')
  })
})
