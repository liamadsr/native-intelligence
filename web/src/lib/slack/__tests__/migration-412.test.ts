/**
 * Migration 412: Slack install + link. Pins the security shape (read-only RLS
 * for people, no client writes, codes and events service-only) and what the
 * store relies on.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/412_slack_connection.sql'), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')

const TABLES = ['slack_installation', 'slack_user_link', 'slack_link_code', 'slack_event', 'slack_link_attempt']

describe('migration 412', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('creates every table idempotently with RLS on and no client write policy', () => {
    for (const t of TABLES) {
      expect(BODY).toContain(`create table if not exists public.${t} (`)
      expect(BODY).toContain(`alter table public.${t} enable row level security`)
    }
    expect(BODY).not.toMatch(/for (insert|update|delete|all) to (authenticated|anon)/)
  })

  it('lets people read only their own links and their workspace installations; codes and events not at all', () => {
    expect(BODY).toContain('create policy slack_user_link_own_select on public.slack_user_link for select to authenticated using ((select auth.uid()) = user_id)')
    expect(BODY).toContain('create policy slack_installation_member_select on public.slack_installation for select to authenticated using (public.is_workspace_member(workspace_id))')
    expect(BODY).not.toMatch(/create policy \w+ on public\.slack_link_code/)
    expect(BODY).not.toMatch(/create policy \w+ on public\.slack_event/)
    expect(BODY).not.toMatch(/create policy \w+ on public\.slack_link_attempt/)
  })

  it('binds a team to one workspace, and links one Slack user and one person per team', () => {
    expect(BODY).toContain("slack_team_id text primary key check (slack_team_id ~ '^T[A-Z0-9]{2,30}$')")
    expect(BODY).toContain('primary key (slack_team_id, slack_user_id)')
    expect(BODY).toContain('constraint slack_user_link_person_uq unique (slack_team_id, user_id)')
    expect(BODY).toContain("status text not null default 'active' check (status in ('active', 'revoked'))")
  })

  it('keeps only a hash of each code, unique', () => {
    expect(BODY).toContain("code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$')")
    expect(BODY).toContain('constraint slack_link_code_hash_uq unique (code_hash)')
    expect(BODY).not.toMatch(/\bcode text\b/)
  })

  it('keys event dedupe on the event id', () => {
    expect(BODY).toContain('event_id text primary key')
  })
})
