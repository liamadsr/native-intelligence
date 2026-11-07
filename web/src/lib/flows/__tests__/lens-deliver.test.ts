/**
 * Each lens's delivery after the one read (F3, lens-deliver.ts): content
 * moments kept for the post pass, marketing findings kept and the product
 * doc's batch at most once a day, findings a run couldn't vouch for applied
 * in a batch of their own (labelled, never held, and never raising a grade),
 * and a workspace lens delivered once however many flows name it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { lensFakeDb } from './lens-fake-db'
import type { LensCallFacts, LensRide } from '../lenses'

const h = vi.hoisted(() => ({
  deliverConnectorItems: vi.fn(),
  resolveCanonDocument: vi.fn(),
}))
vi.mock('../deliver-connector', () => ({ deliverConnectorItems: h.deliverConnectorItems }))
vi.mock('@/lib/documents/canon-doc', () => ({ resolveCanonDocument: h.resolveCanonDocument }))

const { deliverLensSections, lensRidesFailed } = await import('../lens-deliver')

const FACTS: LensCallFacts = { captureId: 'cap-1', captureTitle: 'Acme sync', memberIdsOnCall: ['m-liam'], external: true, outsideNames: ['Dana Whitfield'] }
const ride = (lens: 'content' | 'marketing', flowId: string, member = 'm-liam'): LensRide => ({ flowId, actionId: `a-${flowId}`, lens, ownerUserId: `u-${member}`, ownerMemberId: member, ownerName: 'Liam' })

function ctx(client: never, over: Record<string, unknown> = {}) {
  return { supabase: client, workspaceId: 'ws-1', captureId: 'cap-1', captureTitle: 'Acme sync', runKey: 'evt-1', readOutside: false, facts: FACTS, skillName: 'Proposal Triage', ...over }
}

/** The call as the owner-words check reads it: Liam recorded it (his mic is local_0), Ana is identified as remote_2. */
const CALL = {
  captures: [
    {
      id: 'cap-1',
      workspace_id: 'ws-1',
      user_id: 'u-m-liam',
      transcript: [
        '[local_0] We cut onboarding to one single step and activation doubled.',
        '[remote_2] Ana here: our sales calls went much shorter after the demo change.',
        '[remote_1] Dana: we just use a spreadsheet for now.',
      ].join('\n'),
    },
  ],
  capture_participant: [{ capture_id: 'cap-1', member_id: 'm-ana', speaker_label: 'remote_2', is_self: false, self_binding: 'none' }],
}

const MARKETING = {
  items: [
    { kind: 'objection', text: 'Worried about setup time', quote: 'we have no time to set things up' },
    { kind: 'competitor', text: 'A shared spreadsheet', quote: 'we just use a spreadsheet' },
    { kind: 'testimonial', text: 'Saves a day a week', quote: 'it saves me a day a week' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  h.resolveCanonDocument.mockResolvedValue({ ok: true, doc: { id: 'doc-1', content: '## Messaging\n\n## Positioning\n' } })
  h.deliverConnectorItems.mockImplementation(async (_to: string, items: unknown[]) => ({ to: 'doc_proposals', delivered: items.length, refused: [], summary: `Updated ${items.length} sections in Product` }))
})

describe('content', () => {
  it("keeps the owner's moments as lens findings for the post pass, and a retry adds none", async () => {
    const db = lensFakeDb(CALL)
    const raw = { content: { moments: [{ member_id: 'm-liam', text: 'We cut onboarding to one step.', theme: 'onboarding' }, { member_id: 'm-liam', text: 'Our sales calls went much shorter after the demo change.' }] } }
    const [out] = await deliverLensSections(raw, [ride('content', 'f-content')], ctx(db.client))
    // The second is Ana's line: not in Liam's own words on the call (S3/S8), however the model labelled it.
    expect(out).toMatchObject({ flow_id: 'f-content', status: 'success', delivered: { delivered: 1, summary: 'Kept 1 moment for your posts', refused: ["a moment that isn't in your own words on the call"] } })
    expect(db.tables.lens_finding).toHaveLength(1)
    expect(db.tables.lens_finding[0]).toMatchObject({ member_id: 'm-liam', flow_id: 'f-content', capture_id: 'cap-1', lens: 'content', kind: 'post_moment', status: 'new', body: { text: 'We cut onboarding to one step.', theme: 'onboarding' } })
    await deliverLensSections(raw, [ride('content', 'f-content')], ctx(db.client))
    expect(db.tables.lens_finding).toHaveLength(1)
  })

  it('two voices on the recorder\'s own microphone: its lines are nobody\'s in particular, so nothing is kept (review R3)', async () => {
    const room = { captures: [{ ...CALL.captures[0], transcript: '[local_0] We cut onboarding to one single step and activation doubled.\n[local_1] Sure, sounds good.' }] }
    const db = lensFakeDb(room)
    const [out] = await deliverLensSections({ content: { moments: [{ member_id: 'm-liam', text: 'We cut onboarding to one step.' }] } }, [ride('content', 'f-content')], ctx(db.client))
    expect(out.delivered).toMatchObject({ delivered: 0 })
  })

  it("a call where the owner's lines can't be told apart keeps nothing", async () => {
    const db = lensFakeDb({ captures: [{ ...CALL.captures[0], user_id: 'u-someone-else' }] })
    const [out] = await deliverLensSections({ content: { moments: [{ member_id: 'm-liam', text: 'We cut onboarding to one step.' }] } }, [ride('content', 'f-content')], ctx(db.client))
    expect(out.delivered).toMatchObject({ delivered: 0 })
    expect(db.tables.lens_finding).toHaveLength(0)
  })

  it('a lens left out of the result is "nothing worth keeping", never a failure', async () => {
    const db = lensFakeDb()
    const [out] = await deliverLensSections({}, [ride('content', 'f-content')], ctx(db.client))
    expect(out).toMatchObject({ status: 'success', delivered: { delivered: 0, summary: 'Nothing worth keeping from this call' } })
    expect(db.writes).toHaveLength(0)
  })

  it('two people with content lenses each keep only their own moments', async () => {
    const db = lensFakeDb(CALL)
    const raw = { content: { moments: [{ member_id: 'm-liam', text: 'Onboarding is one single step now.' }, { member_id: 'm-ana', text: 'Sales calls went shorter after the demo change.' }] } }
    const out = await deliverLensSections(raw, [ride('content', 'f-ana', 'm-ana'), ride('content', 'f-liam')], ctx(db.client))
    expect(out.map((o) => o.delivered?.delivered)).toEqual([1, 1])
    expect(db.tables.lens_finding.map((r) => [r.member_id, (r.body as { text: string }).text])).toEqual([
      ['m-ana', 'Sales calls went shorter after the demo change.'],
      ['m-liam', 'Onboarding is one single step now.'],
    ])
  })
})

describe('marketing', () => {
  it("keeps every finding, then the day's first batch puts the non-testimonials in the product doc, one edit per section", async () => {
    const db = lensFakeDb()
    const [out] = await deliverLensSections({ marketing: MARKETING }, [ride('marketing', 'f-mkt')], ctx(db.client))
    expect(db.tables.lens_finding).toHaveLength(3)
    expect(h.deliverConnectorItems).toHaveBeenCalledTimes(1)
    const [to, edits, dctx] = h.deliverConnectorItems.mock.calls[0]
    expect(to).toBe('doc_proposals')
    expect(edits.map((e: { section: string }) => e.section).sort()).toEqual(['Messaging', 'Positioning'])
    expect(dctx).toMatchObject({ docKey: 'product', runAsUserId: 'u-m-liam', memberId: 'm-liam', readOutside: false, sources: [{ kind: 'capture', id: 'cap-1' }] })
    // The testimonial stays internal: new, never in the doc.
    const byKind = Object.fromEntries(db.tables.lens_finding.map((r) => [r.kind, r.status]))
    expect(byKind).toEqual({ objection: 'used', competitor: 'used', testimonial: 'new' })
    expect(out.status).toBe('success')
  })

  it('a second external call the same day keeps its findings for tomorrow: at most one batch a day', async () => {
    const db = lensFakeDb()
    await deliverLensSections({ marketing: MARKETING }, [ride('marketing', 'f-mkt')], ctx(db.client))
    const second = { items: [{ kind: 'objection', text: 'Price', quote: 'it costs too much for us' }] }
    const [out] = await deliverLensSections({ marketing: second }, [ride('marketing', 'f-mkt')], ctx(db.client, { captureId: 'cap-2' }))
    expect(h.deliverConnectorItems).toHaveBeenCalledTimes(1)
    expect(out.delivered?.summary).toMatch(/next batch \(at most one a day\)/)
    expect(db.tables.lens_finding.find((r) => r.capture_id === 'cap-2')?.status).toBe('new')
  })

  it('a refused batch gives its findings back for the next one, not spent', async () => {
    h.deliverConnectorItems.mockResolvedValue({ to: 'doc_proposals', delivered: 0, refused: ['Messaging: over budget'], summary: 'Nothing delivered' })
    const db = lensFakeDb()
    await deliverLensSections({ marketing: MARKETING }, [ride('marketing', 'f-mkt')], ctx(db.client))
    const nonTestimonial = db.tables.lens_finding.filter((r) => r.kind !== 'testimonial')
    expect(nonTestimonial.every((r) => r.status === 'new' && r.used_at === null)).toBe(true)
  })

  it("a finding from a run that read outside text applies in its own batch (so its edits are labelled), and is spent like any other", async () => {
    const db = lensFakeDb()
    const [out] = await deliverLensSections({ marketing: MARKETING }, [ride('marketing', 'f-mkt')], ctx(db.client, { readOutside: true }))
    expect(h.deliverConnectorItems).toHaveBeenCalledTimes(1)
    expect(h.deliverConnectorItems.mock.calls[0][2]).toMatchObject({ readOutside: true })
    expect(db.tables.lens_finding.filter((r) => r.kind !== 'testimonial').every((r) => (r.body as { read_outside: boolean }).read_outside)).toBe(true)
    expect(db.tables.lens_finding.filter((r) => r.kind !== 'testimonial').every((r) => r.status === 'used')).toBe(true)
    expect(out.delivered).not.toHaveProperty('held')
  })

  it('the guest\'s exact words never reach the product doc (review B2): only our lines, the quote stays on the finding', async () => {
    const db = lensFakeDb()
    await deliverLensSections({ marketing: MARKETING }, [ride('marketing', 'f-mkt')], ctx(db.client))
    const edits = h.deliverConnectorItems.mock.calls[0][1] as Array<{ text: string }>
    const all = edits.map((e) => e.text).join('\n')
    expect(all).toContain('- Objection heard: Worried about setup time [assumption]')
    expect(all).not.toContain('we have no time to set things up')
    expect(all).not.toContain('we just use a spreadsheet')
    expect(db.tables.lens_finding.find((r) => r.kind === 'objection')?.body).toMatchObject({ quote: 'we have no time to set things up' })
  })

  it('a line the doc already has is not proposed again', async () => {
    h.resolveCanonDocument.mockResolvedValue({ ok: true, doc: { id: 'doc-1', content: '## Messaging\n- Objection heard: Worried about setup time [assumption]\n' } })
    const db = lensFakeDb()
    await deliverLensSections({ marketing: MARKETING }, [ride('marketing', 'f-mkt')], ctx(db.client))
    const edits = h.deliverConnectorItems.mock.calls[0][1] as Array<{ section: string }>
    expect(edits.map((e) => e.section)).toEqual(['Positioning'])
  })

  it('an owner who may not edit the product doc: findings are kept and stay open', async () => {
    h.deliverConnectorItems.mockResolvedValue({ to: 'doc_proposals', delivered: 0, refused: ["this loop's owner can't edit `product`"], summary: "Nothing delivered: this loop's owner can't edit `product`" })
    const db = lensFakeDb()
    const [out] = await deliverLensSections({ marketing: MARKETING }, [ride('marketing', 'f-mkt')], ctx(db.client))
    expect(db.tables.lens_finding.every((r) => r.status === 'new')).toBe(true)
    expect(out.delivered?.refused).toContain("this loop's owner can't edit `product`")
  })

  it('a workspace lens is delivered once, by its first flow; another flow records it rode along', async () => {
    const db = lensFakeDb()
    const out = await deliverLensSections({ marketing: MARKETING }, [ride('marketing', 'f-b'), ride('marketing', 'f-a')], ctx(db.client))
    expect(h.deliverConnectorItems).toHaveBeenCalledTimes(1)
    expect(out.map((o) => o.flow_id)).toEqual(['f-a', 'f-b'])
    expect(out[1].delivered?.summary).toMatch(/Delivered once for the workspace/)
  })

  it('a dry run writes nothing', async () => {
    const db = lensFakeDb()
    const [out] = await deliverLensSections({ marketing: MARKETING }, [ride('marketing', 'f-mkt')], ctx(db.client, { dryRun: true }))
    expect(db.writes).toHaveLength(0)
    expect(h.deliverConnectorItems).not.toHaveBeenCalled()
    expect(out.delivered).toMatchObject({ dry_run: true })
  })
})

it('every ride fails the same way when the read produced nothing', () => {
  expect(lensRidesFailed([ride('marketing', 'f2'), ride('content', 'f1')], 'no read').map((r) => [r.flow_id, r.status])).toEqual([
    ['f1', 'failed'],
    ['f2', 'failed'],
  ])
})
