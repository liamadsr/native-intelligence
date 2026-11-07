/**
 * Migration 354: agents act by default, every workspace on Dial8's trust
 * defaults (Liam, 2026-10-17). Pins: no backslash; a 5 s lock timeout; the
 * autonomy backfill never touches a workspace switched 'off' (the kill switch
 * is the one choice left) and keeps every other key; role teammates are NOT
 * seeded up front (the auto-attempt gate creates them on first need,
 * ensureRoleTeammates); the trust step removes exactly the two override keys; nothing is dropped or
 * deleted, and HubSpot settings are not touched.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/354_act_by_default.sql'), 'utf8')
const code = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

describe('migration 354', () => {
  it('has no backslash anywhere in the file, and waits at most 5 s for a lock', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(code).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('autonomy: unset, propose or unknown → attempt; off and attempt are left alone; other keys kept', () => {
    expect(code).toMatch(/coalesce\(w\.settings -> 'agent_autonomy' ->> 'mode', ''\) NOT IN \('off', 'attempt'\)/)
    expect(code).toContain(`END || '{"mode": "attempt"}'::jsonb`)
    expect(code).toContain("jsonb_typeof(w.settings) = 'object'")
  })

  it('role teammates: not seeded here (the gate creates them the first time work needs one)', () => {
    expect(code).not.toContain('seed_role_teammates')
  })

  it('trust: removes trust_policy and the legacy auto_accept_policy, only where present', () => {
    expect(code).toContain("SET settings = w.settings - 'trust_policy' - 'auto_accept_policy'")
    expect(code).toContain("(w.settings ? 'trust_policy' OR w.settings ? 'auto_accept_policy')")
  })

  it('drops and deletes nothing, and leaves HubSpot settings alone', () => {
    expect(code).not.toMatch(/\b(drop|delete|truncate|alter)\b/i)
    expect(code).not.toContain('hubspot')
  })
})
