/**
 * The product doc's grades move with the evidence (marketing M1, P9:
 * marketing/regrade.ts through lens-deliver.ts): a call that repeats a line
 * already in the doc adds no second line and counts for it; two companies
 * make it proven; findings of one batch that say the same thing are one line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { lensFakeDb } from './lens-fake-db'
import type { LensCallFacts, LensRide } from '../lenses'
import { claimBody, matchingLine, regradedSection, similarLine, withGrade } from '@/lib/marketing/regrade'

const h = vi.hoisted(() => ({
  deliverConnectorItems: vi.fn(),
  resolveCanonDocument: vi.fn(),
  evidence: vi.fn(),
}))
vi.mock('../deliver-connector', () => ({ deliverConnectorItems: h.deliverConnectorItems }))
vi.mock('@/lib/documents/canon-doc', () => ({ resolveCanonDocument: h.resolveCanonDocument }))
// Companies counted from the calls' participants (claim-evidence.ts): one per call here.
vi.mock('@/lib/marketing/claim-evidence', () => ({ evidenceFromSources: h.evidence }))

const { deliverLensSections } = await import('../lens-deliver')

const FACTS: LensCallFacts = { captureId: 'cap-2', captureTitle: 'Globex sync', memberIdsOnCall: ['m-liam'], external: true, outsideNames: [] }
const ride: LensRide = { flowId: 'f-market', actionId: 'a-1', lens: 'marketing', ownerUserId: 'u-liam', ownerMemberId: 'm-liam', ownerName: 'Liam' }
const ctx = (client: never) => ({ supabase: client, workspaceId: 'ws-1', captureId: 'cap-2', captureTitle: 'Globex sync', runKey: 'evt-2', readOutside: false, facts: FACTS, skillName: 'Proposal Triage' })

const DOC = [
  '## Messaging',
  '- Objection heard: worried setup takes too much time for a small team [assumption]',
  '- How customers put it: notes that write themselves [assumption]',
  '',
  '## Positioning',
  '- Compared with: a shared spreadsheet kept by hand [assumption]',
  '',
  '## Open questions',
  '- Do teams under five people need the CRM at all?',
].join('\n')

beforeEach(() => {
  vi.clearAllMocks()
  h.resolveCanonDocument.mockResolvedValue({ ok: true, doc: { id: 'doc-1', content: DOC, revision: 12 } })
  h.deliverConnectorItems.mockImplementation(async (_to: string, items: unknown[]) => ({ to: 'doc_proposals', delivered: items.length, refused: [], summary: 'Updated Messaging in Product' }))
  h.evidence.mockImplementation(async (_s: unknown, _w: string, sources: Array<{ id: string }>) => ({ companies: new Set(sources.map((s) => s.id)).size, documents: 0, metrics: 0 }))
})

describe('regrade (pure)', () => {
  it('two lines say the same thing: the same kind and most of the same words', () => {
    expect(similarLine('- Objection heard: setup takes too much time for a small team [assumption]', '- Objection heard: worried that setup takes too much time for small teams [assumption]')).toBe(true)
    expect(similarLine('- Objection heard: setup takes too much time [assumption]', '- Compared with: setup takes too much time [assumption]')).toBe(false)
    expect(similarLine('- Objection heard: pricing is too high for us [assumption]', '- Objection heard: setup takes too much time [assumption]')).toBe(false)
    expect(claimBody('- Compared with: a shared spreadsheet [proven]')).toBe('a shared spreadsheet')
  })

  it('a grade only rises, and the rest of the section stays word for word', () => {
    expect(withGrade('- x y z [assumption]', 'proven')).toBe('- x y z [proven]')
    expect(withGrade('- x y z [proven]', 'assumption')).toBe('- x y z [proven]')
    const lines = ['- Objection heard: onboarding takes weeks longer [assumption]', '- Something a person wrote, ungraded']
    expect(regradedSection(lines, new Map([[lines[0], 'proven' as const]]))).toBe('- Objection heard: onboarding takes weeks longer [proven]\n- Something a person wrote, ungraded')
    expect(regradedSection(lines, new Map())).toBeNull()
    expect(matchingLine(lines, '- Objection heard: onboarding takes many weeks longer [assumption]')).toBe(lines[0])
  })

  it('the 0.6 line: three of five shared words is the same line; two of five is not (near miss)', () => {
    const a = '- Objection heard: pricing unclear onboarding slow support [assumption]'
    expect(similarLine(a, '- Objection heard: pricing unclear onboarding fine elsewhere [assumption]')).toBe(true)
    expect(similarLine(a, '- Objection heard: pricing unclear contracts fine elsewhere [assumption]')).toBe(false)
  })
})

describe('the marketing batch regrades from evidence (M1)', () => {
  it('a finding from a run that read outside text never raises a grade (no hold to check it any more)', async () => {
    const db = lensFakeDb({
      lens_finding: [{ id: 'old-1', workspace_id: 'ws-1', member_id: 'm-liam', flow_id: 'f-market', capture_id: 'cap-1', lens: 'marketing', kind: 'objection', status: 'used', created_at: new Date(Date.now() - 86_400_000).toISOString(), used_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), body: { text: 'Worried setup takes too much time for a small team', quote: 'no time to set up' } }],
    })
    const raw = { marketing: { items: [{ kind: 'objection', text: 'Setup takes too much time for a small team like theirs', quote: 'we cannot spend weeks on setup' }] } }
    const [out] = await deliverLensSections(raw, [ride], { ...ctx(db.client), readOutside: true })
    expect(out.status).toBe('success')
    // The line is already in the doc and nothing outside-read may move its grade: no edit at all, and the finding is spent.
    expect(h.deliverConnectorItems).not.toHaveBeenCalled()
    expect(db.tables.lens_finding.find((r) => r.capture_id === 'cap-2')?.status).toBe('used')
  })

  it('a second company repeating a line already in the doc: no second line, the line becomes proven', async () => {
    const db = lensFakeDb({
      // Yesterday's finding from another company's call, already used.
      lens_finding: [{ id: 'old-1', workspace_id: 'ws-1', member_id: 'm-liam', flow_id: 'f-market', capture_id: 'cap-1', lens: 'marketing', kind: 'objection', status: 'used', created_at: new Date(Date.now() - 86_400_000).toISOString(), used_at: new Date(Date.now() - 86_400_000).toISOString(), body: { text: 'Worried setup takes too much time for a small team', quote: 'no time to set up' } }],
      captures: [{ id: 'cap-1', workspace_id: 'ws-1', visibility: 'workspace', user_id: 'u-someone' }],
    })
    // Not today's batch yet: the claim reads only today's.
    db.tables.lens_finding[0].used_at = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const raw = { marketing: { items: [{ kind: 'objection', text: 'Setup takes too much time for a small team like theirs', quote: 'we cannot spend weeks on setup' }] } }
    const [out] = await deliverLensSections(raw, [ride], ctx(db.client))
    expect(out.status).toBe('success')
    const [, edits, opts] = h.deliverConnectorItems.mock.calls[0] as [string, Array<Record<string, unknown>>, Record<string, unknown>]
    expect(edits).toEqual([
      expect.objectContaining({
        section: 'Messaging',
        op: 'replace',
        text: '- Objection heard: worried setup takes too much time for a small team [proven]\n- How customers put it: notes that write themselves [assumption]',
      }),
    ])
    expect(String(edits[0].reason)).toContain('regraded 1 line from the evidence')
    // The edit names both calls, so the doc's own check counts two companies for [proven].
    expect((opts.sources as Array<{ id: string }>).map((s) => s.id).sort()).toEqual(['cap-1', 'cap-2'])
    expect(out.delivered?.summary).toContain('1 grade moved with the evidence')
    // Applied against the snapshot it was built from: a person's edit in between is a conflict.
    expect(opts.baseRevision).toBe(12)
  })

  it('another member’s PRIVATE call is never evidence (S9): no regrade from it', async () => {
    const db = lensFakeDb({
      lens_finding: [{ id: 'old-1', workspace_id: 'ws-1', member_id: 'm-ana', flow_id: 'f-other', capture_id: 'cap-1', lens: 'marketing', kind: 'objection', status: 'used', created_at: new Date(Date.now() - 86_400_000).toISOString(), used_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), body: { text: 'Worried setup takes too much time for a small team', quote: 'no time to set up' } }],
      captures: [{ id: 'cap-1', workspace_id: 'ws-1', visibility: 'private', user_id: 'u-ana' }],
    })
    const raw = { marketing: { items: [{ kind: 'objection', text: 'Setup takes too much time for a small team like theirs', quote: 'we cannot spend weeks on setup' }] } }
    await deliverLensSections(raw, [ride], ctx(db.client))
    expect(h.deliverConnectorItems).not.toHaveBeenCalled()
  })

  it('one company saying it again: nothing to change, the finding is spent, no edit', async () => {
    const db = lensFakeDb({})
    const raw = { marketing: { items: [{ kind: 'competitor', text: 'A shared spreadsheet kept by hand by the team', quote: 'we keep a spreadsheet' }] } }
    await deliverLensSections(raw, [ride], ctx(db.client))
    expect(h.deliverConnectorItems).not.toHaveBeenCalled()
    expect(db.tables.lens_finding.every((f) => f.status === 'used')).toBe(true)
  })

  it('a new line two companies said in one batch goes in once, proven', async () => {
    const db = lensFakeDb({
      lens_finding: [{ id: 'new-1', workspace_id: 'ws-1', member_id: 'm-liam', flow_id: 'f-market', capture_id: 'cap-1', lens: 'marketing', kind: 'customer_language', status: 'new', created_at: new Date().toISOString(), used_at: null, body: { text: 'A second brain for every customer call', quote: 'it is like a second brain' } }],
    })
    const raw = { marketing: { items: [{ kind: 'customer_language', text: 'Like a second brain for each customer call', quote: 'honestly a second brain for calls' }] } }
    await deliverLensSections(raw, [ride], ctx(db.client))
    const [, edits] = h.deliverConnectorItems.mock.calls[0] as [string, Array<Record<string, unknown>>]
    expect(edits).toEqual([expect.objectContaining({ section: 'Messaging', op: 'append', text: '- How customers put it: A second brain for every customer call [proven]' })])
  })
})
