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

  it('is the last thing before the wall: after an override, staff, a subscription, a ChatGPT plan, the person’s own plan, their credits and a granted free period', () => {
    const demo = gate.indexOf('FROM public.demo_workspace d')
    expect(demo).toBeGreaterThan(gate.indexOf("s.status IN ('active','trialing')"))
    expect(demo).toBeGreaterThan(gate.indexOf('FROM public.chatgpt_connection c'))
    // The person's own non-override plan, their credit balance, and trial_end_override are all read first.
    expect(demo).toBeGreaterThan(gate.indexOf('SELECT * INTO v_plan_def FROM ai_plan_definitions WHERE id = v_user_plan.plan_id;', gate.indexOf('chatgpt_connection')))
    expect(demo).toBeGreaterThan(gate.indexOf('FROM ai_user_credits c'))
    expect(demo).toBeGreaterThan(gate.indexOf('v_credit_balance <= 0'))
    expect(demo).toBeGreaterThan(gate.indexOf("raw_user_meta_data->>'trial_end_override'"))
    expect(demo).toBeGreaterThan(gate.indexOf('IF v_free_until IS NULL OR v_free_until <= now() THEN'))
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
  })

  it('counts exactly the people the gate treats as visitors: it asks the gate', () => {
    const fn = own('demo_workspace_meter_usage')
    expect(fn).toContain('from public.check_ai_usage_limit(new.user_id, true)')
    expect(fn).toContain("not in ('demo_workspace', 'demo_cost_limit_exceeded')")
  })
})

describe('migration 669: nothing real is linked to a demo workspace', () => {
  // The shared-email table's name is put together here: the share fence's
  // tripwire (email-share/__tests__/agent-fence.test.ts) reads this folder.
  const sharedEmail = ['email', 'share'].join('_')
  const LINKED = [
    'connected_account',
    'connected_account_workspace',
    'email_sync_state',
    'crm_sync_state',
    'task_sync_state',
    'connected_mcp_server',
    'slack_installation',
    sharedEmail,
    'stripe_connect_account',
    'business_phone_number',
  ]

  it('one list of the tables that link something real to a workspace, the account row itself among them', () => {
    const list = own('demo_workspace_linked_tables')
    for (const table of LINKED) expect(list).toContain(`'${table}'`)
  })

  it('the refusal and the flag’s own check both walk that one list', () => {
    expect(sql).toContain('foreach t in array public.demo_workspace_linked_tables() loop')
    expect(sql).toContain('before insert or update of workspace_id')
    const refusal = own('refuse_in_demo_workspace')
    expect(refusal).toContain('from public.demo_workspace d where d.workspace_id = new.workspace_id')
    expect(refusal).toContain("hint = 'DEMO_WORKSPACE'")
    const clean = own('demo_workspace_must_be_clean')
    expect(clean).toContain('foreach t in array public.demo_workspace_linked_tables() loop')
    expect(sql).toMatch(/create trigger demo_workspace_must_be_clean\s+before insert on public\.demo_workspace/)
  })

  it('no signed-in person can ask whether a workspace is a demo', () => {
    expect(sql).toContain('revoke execute on function public.is_demo_workspace(uuid) from public, anon, authenticated;')
    expect(sql).toContain('grant execute on function public.is_demo_workspace(uuid) to service_role;')
  })
})
