/**
 * check_ai_usage_limit's staff exemption (the database's twin of
 * lib/billing/access.ts) names the same people as ADMIN_EMAILS
 * (lib/admin-emails.ts), never a domain (security review 2026-10-31,
 * migration 468). Follows the function forward: the newest migration that
 * defines it is the one checked, so a later redefinition is held to it too.
 */
import { describe, expect, it } from 'vitest'
import { latestDefinition, migrationsInOrder } from '@/test/migration-sql'
import { ADMIN_EMAILS } from '../admin-emails'

const TWO_ARG = 'CREATE OR REPLACE FUNCTION public.check_ai_usage_limit(p_user_id uuid, p_chatgpt_plan boolean)'

/** The newest migration's (uuid, boolean) overload, or '' when none defines it. */
function latestTwoArg(): { file: string; block: string } {
  const all = migrationsInOrder()
  for (let i = all.length - 1; i >= 0; i--) {
    const { blocks } = latestDefinition('check_ai_usage_limit', [all[i]])
    const block = blocks.find((b) => b.startsWith(TWO_ARG))
    if (block) return { file: all[i].file, block }
  }
  return { file: '(none)', block: '' }
}

describe('check_ai_usage_limit staff exemption', () => {
  const { file, block } = latestTwoArg()

  it('is defined in 468 or later', () => {
    expect(block).not.toBe('')
    expect(Number.parseInt(file, 10)).toBeGreaterThanOrEqual(468)
  })

  it('exempts exactly ADMIN_EMAILS, by address', () => {
    const m = block.match(/lower\(btrim\(u\.email\)\) IN \(([^)]*)\)/)
    expect(m).not.toBeNull()
    const listed = [...m![1].matchAll(/'([^']+)'/g)].map((v) => v[1]).sort()
    expect(listed).toEqual([...ADMIN_EMAILS].map((e) => e.trim().toLowerCase()).sort())
  })

  it('has no domain match left', () => {
    expect(block).not.toMatch(/LIKE\s+'%@/i)
    expect(block).not.toMatch(/@dial8\.ai'\s*$/m)
  })

  it('keeps its shape: SECURITY DEFINER, plpgsql, the same return columns', () => {
    expect(block).toContain('LANGUAGE plpgsql')
    expect(block).toContain('SECURITY DEFINER')
    expect(block).toContain(
      'RETURNS TABLE(allowed boolean, reason text, plan_name text, cost_used numeric, cost_limit numeric, tokens_used integer, token_limit integer, is_paid_plan boolean, usage_reset_date timestamp with time zone, credit_balance_usd numeric)',
    )
  })

  it('468 is one re-runnable transaction that keeps the function service-role only', () => {
    const sql = migrationsInOrder().find((m) => m.file === '468_check_ai_usage_limit_admin_allowlist.sql')?.sql ?? ''
    const code = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .trim()
    expect(code.startsWith('begin;')).toBe(true)
    expect(code.endsWith('commit;')).toBe(true)
    expect(code).toContain('REVOKE ALL ON FUNCTION public.check_ai_usage_limit(uuid, boolean) FROM PUBLIC, anon, authenticated;')
    expect(code).toContain('GRANT EXECUTE ON FUNCTION public.check_ai_usage_limit(uuid, boolean) TO service_role;')
  })
})
