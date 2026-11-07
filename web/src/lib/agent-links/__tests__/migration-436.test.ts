/**
 * Migration 436: the email lookup for agent link requests and the sign-up
 * gate's new exemption. Pins the file: the lookup is service-role only and
 * confirmed-only, the hook keeps 242's two exemptions and adds a waiting
 * link request, idempotence, and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/436_agent_link_outside.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 436', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('looks an email up for the service role only, confirmed accounts only', () => {
    expect(BODY).toContain('create or replace function public.agent_link_user_for_email(p_email text) returns uuid')
    expect(BODY).toContain('security definer set search_path')
    expect(BODY).toContain('and u.email_confirmed_at is not null')
    expect(BODY).toContain('revoke execute on function public.agent_link_user_for_email(text) from public, anon, authenticated;')
    expect(BODY).toContain('grant execute on function public.agent_link_user_for_email(text) to service_role;')
  })

  it('the sign-up gate keeps both earlier exemptions and adds a waiting link request', () => {
    expect(BODY).toContain('select 1 from public.invite i')
    expect(BODY).toContain('select 1 from public.signup_invite s')
    expect(BODY).toContain("where l.target_email = v_email and l.target_user_id is null and l.state = 'requested' and (l.expires_at is null or l.expires_at > now())")
    expect(BODY).toContain('revoke execute on function public.hook_require_work_email(jsonb) from authenticated, anon, public;')
    expect(BODY).toContain('grant execute on function public.hook_require_work_email(jsonb) to supabase_auth_admin;')
  })

  it('is idempotent', () => {
    expect(BODY).not.toMatch(/create function/)
    expect(BODY).not.toMatch(/create table (?!if not exists)/)
  })
})
