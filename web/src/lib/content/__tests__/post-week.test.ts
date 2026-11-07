/**
 * The weekly post pass's material (P9, content C1: post-week.ts): what the
 * server reads before the weekly-posts run, the cadence budget, the slow
 * week, and the names no draft may carry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  brief: null as string | null,
  names: [] as string[],
}))
vi.mock('@/lib/documents/canon-doc', () => ({
  resolveCanonDocument: async () => (h.brief === null ? { ok: false, reason: 'not_found' } : { ok: true, doc: { id: 'brief-1', content: h.brief }, memberId: 'm-1', viaPointer: false }),
}))
vi.mock('../recent-call-names', () => ({ recentCallNames: async () => h.names }))
vi.mock('../post-sources', () => ({ crmNames: async () => ({ phrases: ['initech'], words: ['Hooli'], at: 0 }) }))

const { cadenceSlots, clampSlots, loadPostWeekMaterial, momentIdsUsed, neverPostPhrases, renderPostWeekBlock, DEFAULT_POST_SLOTS } = await import('../post-week')
const { lensFakeDb } = await import('@/lib/flows/__tests__/lens-fake-db')

const NOW = new Date('2026-10-20T09:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

beforeEach(() => {
  h.brief = null
  h.names = []
})

describe('the cadence budget (decision 3)', () => {
  it('defaults to 3 and keeps a whole number from 1 to 5', () => {
    expect(DEFAULT_POST_SLOTS).toBe(3)
    expect(clampSlots(undefined)).toBe(3)
    expect(clampSlots(0)).toBe(1)
    expect(clampSlots(9)).toBe(5)
    expect(clampSlots(2.4)).toBe(2)
    expect(clampSlots('4')).toBe(3)
  })

  it('halves after two weeks in a row whose cards all went unused, and says so once', () => {
    const skipped = (key: string, at: string) => ({ runKey: key, createdAt: at, outcomes: ['skipped', 'expired'] as Array<'skipped' | 'expired'> })
    expect(cadenceSlots(3, [skipped('a', daysAgo(14)), skipped('b', daysAgo(7))])).toEqual({ slots: 2, note: "The last two weeks' posts went unused, so this week brings 2 instead of 3." })
    expect(cadenceSlots(1, [skipped('a', daysAgo(14)), skipped('b', daysAgo(7))])).toEqual({ slots: 1, note: null })
  })

  it('keeps the cadence when one of the last two weeks was posted, still waiting, or there is only one week', () => {
    const run = (key: string, at: string, outcomes: Array<'posted' | 'skipped' | 'expired' | 'waiting'>) => ({ runKey: key, createdAt: at, outcomes })
    expect(cadenceSlots(3, [run('a', daysAgo(14), ['skipped']), run('b', daysAgo(7), ['posted', 'skipped'])]).slots).toBe(3)
    expect(cadenceSlots(3, [run('a', daysAgo(14), ['skipped']), run('b', daysAgo(7), ['waiting'])]).slots).toBe(3)
    expect(cadenceSlots(3, [run('b', daysAgo(7), ['skipped'])]).slots).toBe(3)
  })
})

describe('the brief', () => {
  it("turns its Never post bullets into blocked phrases, short ones only", () => {
    const brief = '## Audience\nFounders.\n\n## Never post\n- Acme Corp\n- pricing\n- anything a customer told me in confidence about their roadmap\n\n## Cadence\n3 a week'
    expect(neverPostPhrases(brief)).toEqual(['acme', 'pricing'])
    expect(neverPostPhrases(null)).toEqual([])
    expect(neverPostPhrases('## Themes\n- shipping')).toEqual([])
  })
})

describe('the block the run reads', () => {
  const base = { surface: 'x' as const, moments: [], shipped: [], docs: [], brief: null, slots: 3, cadenceNote: null, slow: false, blockedPhrases: [], blockedWords: [] }

  it('a slow week asks for ideas, marked as ideas, never an empty week', () => {
    const block = renderPostWeekBlock({ ...base, slow: true })
    expect(block).toContain('A slow week')
    expect(block).toContain('Never an empty week: bring 3 ideas instead, each marked `idea: true`')
    expect(block).toContain('An idea is never presented as this week')
  })

  it('a week with material lists it with moment keys, and asks for the slots', () => {
    const block = renderPostWeekBlock({
      ...base,
      moments: [{ key: 'm1', id: 'f-1', text: 'We stopped estimating in points and shipped faster.', theme: 'process', captureTitle: 'Weekly sync' }],
      shipped: [{ identifier: 'ENG-42', title: 'Calendar sync', kind: 'action' }],
      docs: [{ id: 'doc-1', title: 'How we onboard' }],
      cadenceNote: 'Fewer this week.',
    })
    expect(block).toContain('- [m1] We stopped estimating in points and shipped faster. (theme: process)')
    expect(block).toContain('- ENG-42 Calendar sync')
    expect(block).toContain('- How we onboard (document doc-1)')
    expect(block).toContain('Draft up to 3 posts for X from this material')
    expect(block).toContain('names the moments it used in `uses`')
    expect(block).toContain('Fewer this week.')
    expect(block).not.toContain('A slow week')
  })

  it('maps moment keys back to their rows, ignoring unknown keys', () => {
    const m = { moments: [{ key: 'm1', id: 'f-1', text: 't', theme: null, captureTitle: null }, { key: 'm2', id: 'f-2', text: 't', theme: null, captureTitle: null }] }
    expect(momentIdsUsed(m, ['m2', 'M1', 'm9', 'm2'])).toEqual(['f-2', 'f-1'])
  })
})

describe('loadPostWeekMaterial', () => {
  const seed = () => ({
    lens_finding: [
      { id: 'f-1', workspace_id: 'ws-1', member_id: 'm-1', lens: 'content', status: 'new', created_at: daysAgo(3), body: { text: 'Shipping small beats shipping big.', theme: 'shipping' } },
      // Used already, someone else's, too old, another lens: none of these.
      { id: 'f-2', workspace_id: 'ws-1', member_id: 'm-1', lens: 'content', status: 'used', created_at: daysAgo(2), body: { text: 'Old news.' } },
      { id: 'f-3', workspace_id: 'ws-1', member_id: 'm-2', lens: 'content', status: 'new', created_at: daysAgo(2), body: { text: 'Not mine.' } },
      { id: 'f-4', workspace_id: 'ws-1', member_id: 'm-1', lens: 'content', status: 'new', created_at: daysAgo(20), body: { text: 'Too old.' } },
      { id: 'f-5', workspace_id: 'ws-1', member_id: 'm-1', lens: 'marketing', status: 'new', created_at: daysAgo(1), body: { text: 'A customer objection.' } },
    ],
    member: [{ id: 'm-1', workspace_id: 'ws-1', user_id: 'u-1', role: 'member' }],
    team: [
      { id: '7e000000-0000-4000-8000-000000000001', workspace_id: 'ws-1', is_private: false },
      { id: '7e000000-0000-4000-8000-000000000009', workspace_id: 'ws-1', is_private: true },
    ],
    team_member: [],
    contact_share: [],
    actions: [
      { id: 'a-1', workspace_id: 'ws-1', team_id: '7e000000-0000-4000-8000-000000000001', identifier: 'ENG-42', title: 'Calendar sync', confirmation: 'confirmed', 'workflow_state.category': 'completed', updated_at: daysAgo(2) },
      { id: 'a-2', workspace_id: 'ws-1', team_id: '7e000000-0000-4000-8000-000000000001', identifier: 'ENG-43', title: 'Search', confirmation: 'confirmed', 'workflow_state.category': 'started', updated_at: daysAgo(2) },
      // A private team the person isn't on: never in their posts (S4), nor its PR.
      { id: 'a-9', workspace_id: 'ws-1', team_id: '7e000000-0000-4000-8000-000000000009', identifier: 'SEC-1', title: 'Acquisition data room', confirmation: 'confirmed', 'workflow_state.category': 'completed', updated_at: daysAgo(1) },
    ],
    action_github_pr: [
      { workspace_id: 'ws-1', action_id: 'a-1', pr_title: 'Calendar sync', repo_full_name: 'acme/app', pr_number: 7, pr_state: 'merged', last_synced_at: daysAgo(2) },
      { workspace_id: 'ws-1', action_id: 'a-2', pr_title: 'Faster search', repo_full_name: 'acme/app', pr_number: 8, pr_state: 'merged', last_synced_at: daysAgo(1) },
      { workspace_id: 'ws-1', action_id: 'a-9', pr_title: 'Data room export', repo_full_name: 'acme/secret', pr_number: 3, pr_state: 'merged', last_synced_at: daysAgo(1) },
    ],
    document: [
      { id: 'd-1', workspace_id: 'ws-1', title: 'How we onboard', visibility: 'workspace', kind: 'doc', canon_key: null, outside_derived: false, status: 'active', updated_at: daysAgo(1) },
      { id: 'd-2', workspace_id: 'ws-1', title: 'My private notes', visibility: 'private', kind: 'doc', canon_key: null, outside_derived: false, status: 'active', updated_at: daysAgo(1) },
      { id: 'd-3', workspace_id: 'ws-1', title: 'Weekly report', visibility: 'workspace', kind: 'report', canon_key: null, outside_derived: false, status: 'active', updated_at: daysAgo(1) },
      { id: 'd-4', workspace_id: 'ws-1', title: 'Imported PDF', visibility: 'workspace', kind: 'doc', canon_key: null, outside_derived: true, status: 'active', updated_at: daysAgo(1) },
      { id: 'd-5', workspace_id: 'ws-1', title: 'Product', visibility: 'workspace', kind: 'doc', canon_key: 'product', outside_derived: false, status: 'active', updated_at: daysAgo(1) },
    ],
    attention_item: [],
  })

  it('reads the owner’s open moments, what shipped (a merged PR once), published documents only, and the names to keep out', async () => {
    h.names = ['northwind']
    h.brief = '## Never post\n- Globex'
    const { client } = lensFakeDb(seed())
    const m = await loadPostWeekMaterial(client, { workspaceId: 'ws-1', userId: 'u-1', memberId: 'm-1', flowId: 'flow-1', surface: 'x', now: NOW })
    expect(m.moments).toEqual([{ key: 'm1', id: 'f-1', text: 'Shipping small beats shipping big.', theme: 'shipping', captureTitle: null }])
    expect(m.shipped).toEqual([
      { identifier: 'ENG-42', title: 'Calendar sync', kind: 'action' },
      { identifier: 'acme/app#8', title: 'Faster search', kind: 'pr' },
    ])
    expect(m.docs).toEqual([{ id: 'd-1', title: 'How we onboard' }])
    expect(m.brief).toContain('Globex')
    expect(m.blockedPhrases).toEqual(['northwind', 'globex', 'initech'])
    expect(m.blockedWords).toEqual(['Hooli'])
    expect(m).toMatchObject({ slow: false, slots: 3, cadenceNote: null })
  })

  it('a week with nothing is slow: the run brings ideas', async () => {
    const { client } = lensFakeDb({ member: [{ id: 'm-1', workspace_id: 'ws-1', user_id: 'u-1', role: 'member' }], team: [{ id: '7e000000-0000-4000-8000-000000000001', workspace_id: 'ws-1', is_private: false }], team_member: [], contact_share: [], lens_finding: [], actions: [], action_github_pr: [], document: [], attention_item: [] })
    const m = await loadPostWeekMaterial(client, { workspaceId: 'ws-1', userId: 'u-1', memberId: 'm-1', flowId: 'flow-1', surface: 'x', now: NOW })
    expect(m.slow).toBe(true)
    expect(renderPostWeekBlock(m)).toContain('A slow week')
  })

  it('halves the slots after two unused weeks of this loop’s cards', async () => {
    const card = (run: string, at: string, status: string) => ({ workspace_id: 'ws-1', member_id: 'm-1', kind: 'question', 'payload->>flow_id': 'flow-1', run_key: run, status, created_at: at, expires_at: null, payload: { post_draft: { text: 'x' }, flow_id: 'flow-1' } })
    const s = { ...seed(), attention_item: [card('r1', daysAgo(14), 'dismissed'), card('r1', daysAgo(14), 'expired'), card('r2', daysAgo(7), 'dismissed')] }
    const { client } = lensFakeDb(s)
    const m = await loadPostWeekMaterial(client, { workspaceId: 'ws-1', userId: 'u-1', memberId: 'm-1', flowId: 'flow-1', surface: 'x', slots: 4, now: NOW })
    expect(m.slots).toBe(2)
    expect(m.cadenceNote).toContain('instead of 4')
  })
})
