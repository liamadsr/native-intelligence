/**
 * Migration 643: Slack's bot tokens. Pins the security shape (RLS on, no
 * policy, every privilege taken from clients), the columns bot-token.ts
 * reads and writes, re-runnability, and no backslash.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FILE = '643_slack_bot_tokens.sql'
const SQL = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
const STORE = readFileSync(join(process.cwd(), 'src/lib/slack/bot-token.ts'), 'utf8')
const TABLE = BODY.slice(BODY.indexOf('create table if not exists public.slack_bot_token ('), BODY.indexOf('comment on table public.slack_bot_token'))

describe('migration 643', () => {
  it('is the only 643, holds no backslash, and takes its locks with a timeout', () => {
    const numbers = readdirSync(join(process.cwd(), 'supabase/migrations')).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 643)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('is re-runnable', () => {
    expect(BODY).toContain('create table if not exists public.slack_bot_token (')
    expect(BODY).toContain('drop trigger if exists slack_bot_token_updated_at on public.slack_bot_token;')
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    expect(BODY).not.toMatch(/create policy/)
  })

  it('is the service role’s only: RLS on, no policy, every privilege revoked from clients', () => {
    expect(BODY).toContain('alter table public.slack_bot_token enable row level security;')
    expect(BODY).toContain('revoke all on table public.slack_bot_token from public, anon, authenticated;')
    expect(BODY).toContain('grant select, insert, update, delete on table public.slack_bot_token to service_role;')
    expect(BODY).not.toMatch(/grant [a-z, ]+ on table public\.slack_bot_token to (anon|authenticated)/)
  })

  it('holds only ciphertext: the token columns take only the app’s v1 values', () => {
    expect(TABLE).toContain("bot_token_enc text not null check (bot_token_enc ~ '^v1[.]'")
    expect(TABLE).toContain("refresh_token_enc ~ '^v1[.]'")
    expect(TABLE).not.toMatch(/\b(bot_token|access_token|refresh_token) text/)
  })

  it('keys a row by the Slack team, and versions it for compare and set', () => {
    expect(TABLE).toContain("slack_team_id text primary key check (slack_team_id ~ '^T[A-Z0-9]{2,30}$')")
    expect(TABLE).toContain('version bigint not null default 1')
    expect(BODY).toContain('for each row execute function public.update_updated_at();')
  })

  it('has every column bot-token.ts reads or writes', () => {
    const read = /const ROW_COLUMNS = '([^']+)'/.exec(STORE)![1].split(',').map((c) => c.trim())
    const written = ['app_id', 'updated_at']
    for (const c of [...read, ...written]) expect(TABLE, c).toMatch(new RegExp(`[( ,]${c} `))
  })
})
