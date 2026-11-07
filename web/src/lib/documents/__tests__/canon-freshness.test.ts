/**
 * Canon freshness (D3): per-section checks follow the text; a section
 * unchanged and unconfirmed for 90 days is listed for the document view's
 * quiet "not checked since" marker, and NO card asks about it (decision 16);
 * "Mark checked" stamps it confirmed; claims whose quoted text left the
 * document are retired, and a claim left with no source is archived.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const sent = vi.hoisted(() => ({ events: [] as unknown[] }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async (e: unknown) => sent.events.push(e)) } }))

import * as freshness from '../canon-freshness'
import {
  canonSections,
  editRemovedExcerpt,
  loadStaleSections,
  markSectionChecked,
  quoteText,
  planCheckSync,
  runCanonFreshness,
  staleSections,
  syncCanonClaims,
  topSectionKey,
} from '../canon-freshness'

const WS = 'w1'
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-20T04:00:00Z')
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
const DOC = '## What the product is\nMeeting capture.\n\n## Positioning\nVs spreadsheets.\n'

describe('pure parts', () => {
  it('a document’s ## sections, each hashed (whitespace does not count)', () => {
    const a = canonSections(DOC)
    expect(a.map((s) => s.section)).toEqual(['what the product is', 'positioning'])
    expect(canonSections(DOC.replace('Vs spreadsheets.', 'Vs   spreadsheets.'))[1].hash).toBe(a[1].hash)
    expect(canonSections(DOC.replace('Vs spreadsheets.', 'Vs notebooks.'))[1].hash).not.toBe(a[1].hash)
  })

  it('sync: a new or changed section is checked as of the last change; a gone one is dropped', () => {
    const [facts, pos] = canonSections(DOC)
    const rows = [
      { section: facts.section, heading: facts.heading, content_hash: facts.hash, last_verified_at: iso(200), verified_by: null, verified_kind: 'edit' },
      { section: 'old', heading: 'Old', content_hash: 'x', last_verified_at: iso(5), verified_by: null, verified_kind: 'edit' },
    ]
    const plan = planCheckSync([facts, pos], rows, iso(1), 'm-editor')
    expect(plan.upserts.map((u) => [u.section, u.last_verified_at, u.verified_by])).toEqual([['positioning', iso(1), 'm-editor']])
    expect(plan.removed).toEqual(['old'])
  })

  it('lists the sections past 90 days that are still in the document, oldest first; none when fresh', () => {
    const row = (section: string, heading: string, verified: number) => ({ section, heading, last_verified_at: iso(verified) })
    const rows = [row('what the product is', 'What the product is', 100), row('positioning', 'Positioning', 150), row('gone', 'Gone', 400)]
    expect(staleSections(rows, DOC, NOW)).toEqual([
      { heading: 'Positioning', lastVerifiedAt: iso(150) },
      { heading: 'What the product is', lastVerifiedAt: iso(100) },
    ])
    expect(staleSections([row('positioning', 'Positioning', 89)], DOC, NOW)).toEqual([])
  })

  it('keys a section path by its ## section, even under a # title', () => {
    const titled = `# Product doc\n\n${DOC}### Real alternative\nSpreadsheets.\n`
    expect(topSectionKey('Product doc > Positioning', titled)).toBe('positioning')
    expect(topSectionKey('Product doc > Positioning > Real alternative', titled)).toBe('positioning')
    expect(topSectionKey('Positioning > Real alternative')).toBe('positioning')
  })

  it('compares quotes without markdown, quote styles or ellipses (S2)', () => {
    expect(quoteText('- **Cheaper** than [Gong](https://gong.io)…')).toBe('cheaper than gong')
    expect(quoteText('“We stopped using the spreadsheet”')).toBe('"we stopped using the spreadsheet"')
  })

  it('an edit retires only a quote it took out of its own section, gone from the whole document (S2)', () => {
    const edit = { before: 'Vs **spreadsheets**. Cheaper than Gong.', after: 'Vs spreadsheets.', content: `${DOC}\nVs spreadsheets.` }
    expect(editRemovedExcerpt('Cheaper than Gong', edit)).toBe(true)
    // Kept (only reformatted) or never in the section: left alone.
    expect(editRemovedExcerpt('vs spreadsheets', edit)).toBe(false)
    expect(editRemovedExcerpt('Meeting capture', edit)).toBe(false)
    // Removed here but still said elsewhere in the document: left alone.
    expect(editRemovedExcerpt('Cheaper than Gong', { ...edit, content: `${DOC}\n## Messaging\nCheaper than Gong.` })).toBe(false)
    expect(editRemovedExcerpt(null, edit)).toBe(false)
  })

  it('there is no "still true?" card left to raise or read', () => {
    for (const gone of ['sectionToAsk', 'stillTrueFromPayload', 'confirmSectionStillTrue', 'ASK_EVERY_DAYS', 'CHECK_CARD_TTL_MS']) expect(Object.keys(freshness)).not.toContain(gone)
  })
})

let fake: FakeSupabase
beforeEach(() => {
  fake = makeFakeSupabase()
  sent.events = []
})

describe('runCanonFreshness', () => {
  beforeEach(() => {
    fake.seed('document', [{ id: 'd1', workspace_id: WS, title: 'Product', content: DOC, canon_key: 'product', created_by: 'm1', last_edited_by: 'm1', updated_at: iso(120), status: 'active' }])
    fake.seed('member', [
      { id: 'm1', workspace_id: WS, role: 'owner', created_at: iso(400) },
      { id: 'm2', workspace_id: WS, role: 'admin', created_at: iso(300) },
      { id: 'm3', workspace_id: WS, role: 'member', created_at: iso(200) },
    ])
  })

  it('first pass tracks every section as of the last change, and raises no card', async () => {
    const r = await runCanonFreshness(fake as never, WS)
    expect(r).toEqual({ documents: 1, synced: 2 })
    expect(fake.rows('attention_item')).toHaveLength(0)
    expect(fake.rows('document_section_check').map((row) => row.section).sort()).toEqual(['positioning', 'what the product is'])
  })

  it('a stale document shows its sections on the marker, and a second pass changes nothing', async () => {
    await runCanonFreshness(fake as never, WS)
    expect((await runCanonFreshness(fake as never, WS)).synced).toBe(0)
    const stale = await loadStaleSections(fake as never, { workspaceId: WS, documentId: 'd1', content: DOC, nowMs: NOW })
    expect(stale.map((s) => s.heading)).toEqual(['What the product is', 'Positioning'])
    expect(fake.rows('attention_item')).toHaveLength(0)
  })

  it('a fresh document shows nothing', async () => {
    fake.rows('document')[0].updated_at = iso(3)
    await runCanonFreshness(fake as never, WS)
    expect(await loadStaleSections(fake as never, { workspaceId: WS, documentId: 'd1', content: DOC, nowMs: NOW })).toEqual([])
  })

  it('"Mark checked" stamps the section confirmed by whoever clicked, and it leaves the marker', async () => {
    await runCanonFreshness(fake as never, WS)
    expect(await markSectionChecked(fake as never, { workspaceId: WS, documentId: 'd1', section: 'Positioning', memberId: 'm2' })).toBe(true)
    const row = fake.rows('document_section_check').find((r) => r.section === 'positioning')!
    expect(row).toMatchObject({ verified_kind: 'confirmed', verified_by: 'm2' })
    const stale = await loadStaleSections(fake as never, { workspaceId: WS, documentId: 'd1', content: DOC })
    expect(stale.map((s) => s.heading)).toEqual(['What the product is'])
    expect(await markSectionChecked(fake as never, { workspaceId: WS, documentId: 'd1', section: 'Nope', memberId: 'm2' })).toBe(false)
    // A "Parent > Child" path stamps its ## section, the same key an edit stamps (review nit).
    expect(await markSectionChecked(fake as never, { workspaceId: WS, documentId: 'd1', section: 'What the product is > Pricing', memberId: 'm2' })).toBe(true)
    expect(fake.rows('document_section_check').find((r) => r.section === 'what the product is')).toMatchObject({ verified_kind: 'confirmed', verified_by: 'm2' })
  })
})

describe('syncCanonClaims', () => {
  it('extracts from the edited section through the existing job', async () => {
    await syncCanonClaims(fake as never, { workspaceId: WS, userId: 'u', memberId: 'm1', documentId: 'd1', title: 'Product', content: DOC, section: 'Positioning', sectionText: 'Vs spreadsheets: the real alternative customers name on calls.', sectionBefore: '' })
    expect(sent.events).toEqual([
      expect.objectContaining({ name: 'claim/extract-from-source', data: expect.objectContaining({ sourceType: 'document', sourceId: 'd1', sourceLabel: 'Product ▸ Positioning', sourceText: expect.stringContaining('real alternative') }) }),
    ])
  })

  it('retires the claims whose quoted text left the document, and archives a claim left with no source', async () => {
    const ops: Array<{ table: string; op: string; filters: unknown[]; row?: unknown }> = []
    const client = {
      from(table: string) {
        const q = { table, op: 'select', filters: [] as unknown[], row: undefined as unknown }
        ops.push(q)
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'limit']) chain[m] = (...a: unknown[]) => (q.filters.push([m, ...a]), chain)
        chain.delete = () => ((q.op = 'delete'), chain)
        chain.update = (row: unknown) => ((q.op = 'update'), (q.row = row), chain)
        chain.then = (resolve: (r: unknown) => unknown) => {
          let data: unknown = null
          if (table === 'claim_source' && q.op === 'select' && q.filters.some((f) => (f as unknown[])[1] === 'source_type')) {
            data = [
              { id: 's-kept', claim_id: 'c-kept', excerpt: 'Vs spreadsheets' },
              { id: 's-gone', claim_id: 'c-gone', excerpt: 'Vs notebooks' },
              { id: 's-gone2', claim_id: 'c-other', excerpt: 'Cheaper than Gong' },
            ]
          } else if (table === 'claim_source' && q.op === 'select') {
            data = [{ claim_id: 'c-other' }]
          }
          return Promise.resolve({ data, error: null }).then(resolve)
        }
        return chain
      },
    }
    const r = await syncCanonClaims(client as never, {
      workspaceId: WS,
      userId: 'u',
      memberId: null,
      documentId: 'd1',
      title: 'Product',
      content: DOC,
      section: 'Positioning',
      sectionText: 'Vs spreadsheets.',
      sectionBefore: 'Vs spreadsheets. Vs notebooks. Cheaper than Gong.',
    })
    expect(r).toEqual({ retired: 2, archived: 1 })
    expect(ops.find((o) => o.table === 'claim_source' && o.op === 'delete')!.filters).toContainEqual(['in', 'id', ['s-gone', 's-gone2']])
    const archive = ops.find((o) => o.table === 'claim' && o.op === 'update')!
    expect(archive.row).toEqual({ status: 'archived' })
    expect(archive.filters).toContainEqual(['in', 'id', ['c-gone']])
  })

  it('a short or cleared section extracts nothing', async () => {
    await syncCanonClaims(fake as never, { workspaceId: WS, userId: 'u', memberId: null, documentId: 'd1', title: 'Product', content: DOC, section: 'Voice', sectionText: null, sectionBefore: '' })
    expect(sent.events).toHaveLength(0)
  })
})
