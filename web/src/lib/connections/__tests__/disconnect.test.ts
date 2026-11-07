/**
 * The loops a disconnect would stop (disconnect.ts loopsLosing): the
 * person's own, in every workspace, that need what the connection provides,
 * only when nothing else of theirs provides it. An app stops none (no loop
 * can reach one yet).
 */
import { describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '@/test/supabase-mock'

vi.mock('@/lib/tasks/asana-webhook', () => ({ tearDownAsanaWebhooksForAccount: vi.fn() }))
vi.mock('@/lib/tasks/jira-webhook', () => ({ tearDownJiraWebhooksForAccount: vi.fn() }))
vi.mock('@/lib/tasks/linear-config', () => ({ revokeLinearTokenForAccount: vi.fn() }))

const { loopsLosing } = await import('../disconnect')

const LOOPS = [
  { id: 'f1', name: 'Prep', enabled: true, trigger_type: 'calendar_event', actions: [] },
  { id: 'f2', name: 'PRs', enabled: true, trigger_type: 'pr_status_changed', actions: [] },
]
const db = (others: unknown[]) =>
  createSupabaseMock({ tables: { connected_account: { data: others, error: null }, flow: { data: LOOPS, error: null }, recipe: { data: [], error: null } } }) as never
const CAL = { kind: 'integration' as const, id: 'a1', name: 'google:calendar', provider: 'google', capability: 'calendar' }

describe('loopsLosing', () => {
  it('the last calendar: the calendar loop stops', async () => {
    expect(await loopsLosing(db([{ provider: 'google', capability: 'email' }]), 'u1', CAL)).toEqual([{ id: 'f1', name: 'Prep', on: true }])
  })
  it('another calendar still covers it: nothing stops', async () => {
    expect(await loopsLosing(db([{ provider: 'microsoft', capability: 'calendar' }]), 'u1', CAL)).toEqual([])
  })
  it('an app stops nothing', async () => {
    expect(await loopsLosing(db([]), 'u1', { kind: 'app', id: 's1', name: 'Linear' })).toEqual([])
  })
})
