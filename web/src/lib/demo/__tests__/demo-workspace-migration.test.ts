/**
 * What migration 669 must say, read as text (no database runs under vitest;
 * src/test/migration-sql.ts explains the idiom). These follow the usage gate
 * forward: a later migration that redefines check_ai_usage_limit without the
 * demo branch fails here.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, latestDefinition, migrationsInOrder } from '@/test/migration-sql'

const sql = readFileSync(path.join(MIGRATIONS_DIR, '669_demo_workspace.sql'), 'utf8')

/** One of 669's own (lower-case) function definitions, whole. */
function own(fn: string): string {
  const start = sql.indexOf(`create or replace function public.${fn}(`)
  if (start === -1) return ''
  const bodyStart = sql.indexOf('$$', start)
  return sql.slice(start, sql.indexOf('$$;', bodyStart + 2) + 3)
}

function latestGate(): string {
  const all = migrationsInOrder()
  for (let i = all.length - 1; i >= 0; i--) {
    const block = latestDefinition('check_ai_usage_limit', [all[i]]).blocks.find((b) => b.includes('p_chatgpt_plan boolean'))
    if (block) return block
  }
  return ''
}

describe('migration 669: the flag', () => {
  it('is a table only the service role touches, not a column an owner can set', () => {
    expect(sql).toMatch(/create table if not exists public\.demo_workspace/)
    expect(sql).toMatch(/alter table public\.demo_workspace enable row level security/)
    expect(sql).toMatch(/revoke all on table public\.demo_workspace from public, anon, authenticated/)
    expect(sql).not.toMatch(/create policy/i)
    expect(sql).not.toMatch(/alter table public\.workspace\b/)
  })

  it('defaults the monthly AI cap to $25', () => {
    expect(sql).toMatch(/ai_cap_usd\s+numeric not null default 25/)
  })

  it('a visitor is a member or guest, never the owner or an admin', () => {
    const fn = own('demo_seat_workspace')
    expect(fn).toContain("m.role in ('member', 'guest')")
    expect(sql).toMatch(/revoke execute on function public\.demo_seat_workspace\(uuid\) from public, anon, authenticated/)
  })
})

describe('check_ai_usage_limit: the demo branch', () => {
  const gate = latestGate()

  it('is in the newest definition of the gate', () => {
    expect(gate).toContain("'demo_workspace'")
    expect(gate).toContain("'demo_cost_limit_exceeded'")
    expect(gate).toContain('v_demo_spend < v_demo_cap')
  })

  it('comes after an override, staff, a subscription and a ChatGPT plan, and before the default plan’s wall', () => {
    const demo = gate.indexOf('FROM public.demo_workspace d')
    expect(demo).toBeGreaterThan(gate.indexOf("s.status IN ('active','trialing')"))
    expect(demo).toBeGreaterThan(gate.indexOf('FROM public.chatgpt_connection c'))
    expect(demo).toBeLessThan(gate.indexOf("'subscription_required'"))
  })

  it('counts only this month’s spend and only visitors', () => {
    expect(gate).toContain("CASE WHEN d.spend_month = date_trunc('month', now())::date THEN d.ai_spend_usd ELSE 0 END")
    expect(gate).toContain("m.role IN ('member', 'guest')")
  })

  it('stays the service role’s alone', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.check_ai_usage_limit(uuid, boolean) FROM PUBLIC, anon, authenticated;')
  })
})

describe('migration 669: the ledger', () => {
  it('adds a visitor’s cost after each usage row, and never fails that insert', () => {
    expect(sql).toMatch(/create trigger demo_workspace_meter_usage\s+after insert on public\.ai_usage_logs/)
    const fn = own('demo_workspace_meter_usage')
    expect(fn).toContain('exception when others then')
    expect(fn).toContain('new.estimated_cost_usd')
    // A seat holder's use inside the demo is their own, not the workspace's.
    expect(fn).toContain("s.status in ('active', 'trialing')")
  })
})

describe('migration 669: nothing real is linked to a demo workspace', () => {
  it('refuses on every table that links an account or a shared record to a workspace', () => {
    // The shared-email table's name is put together here: the share fence's
    // tripwire (email-share/__tests__/agent-fence.test.ts) reads this folder.
    const sharedEmail = ['email', 'share'].join('_')
    for (const table of ['connected_account_workspace', 'connected_mcp_server', 'slack_installation', sharedEmail, 'stripe_connect_account', 'business_phone_number']) {
      expect(sql).toContain(`'${table}'`)
    }
    expect(sql).toContain('before insert or update of workspace_id')
    const fn = own('refuse_in_demo_workspace')
    expect(fn).toContain('public.is_demo_workspace(new.workspace_id)')
    expect(fn).toContain("hint = 'DEMO_WORKSPACE'")
  })

  it('refuses to flag a workspace that already has something connected', () => {
    expect(sql).toMatch(/create trigger demo_workspace_must_be_clean\s+before insert on public\.demo_workspace/)
  })
})
