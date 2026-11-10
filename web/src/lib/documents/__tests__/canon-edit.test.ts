/**
 * Canon section edits (D2, decision 16): one section by name; a fixed
 * template section is cleared, never deleted; a missing one is added; the
 * write is compare-and-swap, retried once on the new text; it carries its
 * section, reason and sources onto the revision (376) and one digest line.
 * An edit that rests on outside text applies the same way, labelled on the
 * revision and the digest line; nothing here can raise a card. Reverting one
 * edit puts back only that section.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logs = vi.hoisted(() => ({ lines: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn(async () => {}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))
vi.mock('@/lib/log/agent-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log/agent-log')>()),
  appendLogLine: vi.fn(async (input: Record<string, unknown>) => {
    logs.lines.push(input)
    return true
  }),
}))
vi.mock('../access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../access')>()),
  loadDocumentAccess: vi.fn(async () => ({
    access: { role: 'admin', memberId: 'm1', isProductDoc: false, row: { id: 'd1', workspace_id: 'w', created_by: 'm1', type: 'note', slug: null, published_status: 'published', frontmatter: {}, project_id: null, canon_key: 'product', visibility: 'workspace' } },
    error: null,
  })),
}))

import * as canonEdit from '../canon-edit'
import { appendCanonBatchDigestLine, applyCanonSectionEdit, applySectionOp, canonEditMeta, revertSectionEdit } from '../canon-edit'
import { changedSection, putSectionBack } from '../section-diff'

const DOC = '## What the product is\nMeeting capture.\n\n## Positioning\nVs spreadsheets.\n\n## Voice\nPlain.\n'

describe('applySectionOp', () => {
  it('replaces one section and leaves the rest', () => {
    const r = applySectionOp(DOC, { key: 'product', section: 'positioning', op: 'replace', text: 'Vs notebooks.' })
    expect(r.ok && r.content).toBe(DOC.replace('Vs spreadsheets.', 'Vs notebooks.'))
    expect(r.ok && [r.section, r.before, r.after]).toEqual(['Positioning', 'Vs spreadsheets.', 'Vs notebooks.'])
  })

  it('appends to a section', () => {
    const r = applySectionOp(DOC, { key: 'product', section: 'Voice', op: 'append', text: 'Never say synergy.' })
    expect(r.ok && r.after).toBe('Plain.\n\nNever say synergy.')
  })

  it('clears a fixed template section instead of deleting its heading', () => {
    const r = applySectionOp(DOC, { key: 'product', section: 'Voice', op: 'remove', text: '' })
    expect(r.ok && r.content).toContain('## Voice')
    expect(r.ok && r.content).not.toContain('Plain.')
  })

  it('removes a subsection that is not part of the skeleton', () => {
    const doc = `${DOC}\n### Old tagline\nGone soon.\n`
    const r = applySectionOp(doc, { key: 'product', section: 'Old tagline', op: 'remove', text: '' })
    expect(r.ok && r.content).not.toContain('Old tagline')
  })

  it('adds a missing template section (an adopted product doc)', () => {
    const r = applySectionOp(DOC, { key: 'product', section: 'Open questions', op: 'append', text: 'Pricing for teams?' })
    expect(r.ok && r.content.endsWith('## Open questions\n\nPricing for teams?\n')).toBe(true)
  })

  it('refuses a section that is not there, naming the ones that are', () => {
    const r = applySectionOp(DOC, { key: 'team-playbook', section: 'Pricing', op: 'replace', text: 'x' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('"Positioning"')
  })
})

/** A document table that answers reads from `versions` in order and records writes; `conflictOnce` loses the first CAS. */
function docClient(opts: { contents: string[]; conflictOnce?: boolean; revisions?: Array<Record<string, unknown>>; canonKey?: string | null }) {
  let reads = 0
  let revision = 5
  const writes: Array<Record<string, unknown>> = []
  let conflicted = false
  return {
    writes,
    from(table: string) {
      const chain: Record<string, unknown> = {}
      let update: Record<string, unknown> | null = null
      for (const m of ['select', 'eq', 'lte', 'order', 'limit', 'in']) chain[m] = () => chain
      chain.update = (u: Record<string, unknown>) => ((update = u), chain)
      chain.maybeSingle = async () => {
        if (update) return { data: null, error: null }
        const content = opts.contents[Math.min(reads, opts.contents.length - 1)]
        reads++
        return { data: { id: 'd1', title: 'Product', content, revision, project_id: null, canon_key: opts.canonKey === undefined ? 'product' : opts.canonKey }, error: null }
      }
      chain.then = (resolve: (r: unknown) => unknown) => {
        if (table === 'document_revision') return Promise.resolve({ data: opts.revisions ?? [], error: null }).then(resolve)
        // The workspace's owners and admins (the digest line's other readers).
        if (table === 'member') return Promise.resolve({ data: [{ id: 'm-admin', user_id: 'u-admin' }], error: null }).then(resolve)
        if (update) {
          if (opts.conflictOnce && !conflicted) {
            conflicted = true
            revision += 1
            return Promise.resolve({ data: [], error: null }).then(resolve)
          }
          writes.push(update)
          revision += 1
          return Promise.resolve({ data: [{ id: 'd1', title: 'Product', revision }], error: null }).then(resolve)
        }
        return Promise.resolve({ data: null, error: null }).then(resolve)
      }
      return chain
    },
  }
}

beforeEach(() => {
  logs.lines = []
})

describe('applyCanonSectionEdit', () => {
  it('writes the section with its meta, as an agent edit, and logs one digest line', async () => {
    const c = docClient({ contents: [DOC] })
    const r = await applyCanonSectionEdit(c as never, { workspaceId: 'w', userId: 'u', documentId: 'd1', key: 'product', section: 'Positioning', op: 'replace', text: 'Vs notebooks.', reason: 'Two customers said so', sources: [{ kind: 'capture', id: 'c1' }] })
    expect(r).toMatchObject({ ok: true, section: 'Positioning', revision: 6 })
    expect(c.writes[0]).toMatchObject({
      edit_source: 'agent',
      edit_summary: 'Updated "Positioning"',
      edit_meta: { section: 'Positioning', op: 'replace', reason: 'Two customers said so', sources: [{ kind: 'capture', id: 'c1' }] },
    })
    // One line for the person whose agent made it, and one for each owner (S9).
    expect(logs.lines.map((l) => l.userId).sort()).toEqual(['u', 'u-admin'])
    expect(logs.lines[0]).toMatchObject({ kind: 'doc_updated', line: 'Native Intelligence updated Positioning in Product', refId: 'd1', dedupeKey: 'doc:d1:rev:6' })
  })

  it('a conflict re-reads and applies the same section change to the new text', async () => {
    const newer = DOC.replace('Plain.', 'Plain and short.')
    const c = docClient({ contents: [DOC, newer], conflictOnce: true })
    const r = await applyCanonSectionEdit(c as never, { workspaceId: 'w', userId: 'u', documentId: 'd1', key: 'product', section: 'Positioning', op: 'replace', text: 'Vs notebooks.' })
    expect(r).toMatchObject({ ok: true, rebased: true })
    expect(c.writes[0].content).toContain('Plain and short.')
    expect(c.writes[0].content).toContain('Vs notebooks.')
  })

  it('a newer write to THIS section since base_revision is a conflict, never rebased over (S5)', async () => {
    const theirs = DOC.replace('Vs spreadsheets.', 'Vs paper.')
    // The history row for revision 3 (the base) is DOC; the document now is theirs.
    const c = docClient({ contents: [DOC, theirs] })
    const r = await applyCanonSectionEdit(c as never, { workspaceId: 'w', userId: 'u', documentId: 'd1', key: 'product', section: 'Positioning', op: 'replace', text: 'Vs notebooks.', baseRevision: 3 })
    expect(r).toMatchObject({ ok: false, reason: 'conflict' })
    expect(c.writes).toHaveLength(0)
  })

  it('a newer write to another section since base_revision is merged', async () => {
    const other = DOC.replace('Plain.', 'Plain, later.')
    const c = docClient({ contents: [DOC, other] })
    const r = await applyCanonSectionEdit(c as never, { workspaceId: 'w', userId: 'u', documentId: 'd1', key: 'product', section: 'Positioning', op: 'replace', text: 'Vs notebooks.', baseRevision: 3 })
    expect(r).toMatchObject({ ok: true, rebased: true })
    expect(c.writes[0].content).toContain('Plain, later.')
  })

  it('a non-canon document gets the re-index only: no digest line (S2)', async () => {
    const c = docClient({ contents: [DOC], canonKey: null })
    await applyCanonSectionEdit(c as never, { workspaceId: 'w', userId: 'u', documentId: 'd1', key: null, section: 'Positioning', op: 'replace', text: 'Vs notebooks.' })
    expect(logs.lines).toHaveLength(0)
  })

  it('a check refuses the edit before anything is written', async () => {
    const c = docClient({ contents: [DOC] })
    const r = await applyCanonSectionEdit(c as never, { workspaceId: 'w', userId: 'u', documentId: 'd1', key: 'product', section: 'Voice', op: 'append', text: 'x', check: () => 'Over budget' })
    expect(r).toEqual({ ok: false, reason: 'invalid', error: 'Over budget' })
    expect(c.writes).toHaveLength(0)
  })
})

describe('revertSectionEdit', () => {
  it('puts back only the section the edit touched, keeping a later edit to another section', async () => {
    const before = DOC
    const edited = DOC.replace('Vs spreadsheets.', 'Vs notebooks.')
    const now = edited.replace('Plain.', 'Plain, later.')
    const c = docClient({
      contents: [now],
      revisions: [
        { revision_number: 4, content: edited, edit_meta: { section: 'Positioning', op: 'replace' } },
        { revision_number: 3, content: before, edit_meta: null },
      ],
    })
    const r = await revertSectionEdit(c as never, { workspaceId: 'w', userId: 'u', documentId: 'd1', revision: 4 })
    expect(r).toMatchObject({ ok: true, section: 'Positioning', laterChangesToSection: false })
    expect(c.writes[0].content).toContain('Vs spreadsheets.')
    expect(c.writes[0].content).toContain('Plain, later.')
    expect(c.writes[0].edit_meta).toEqual({ section: 'Positioning', op: 'revert', reverts: 4 })
    expect(logs.lines[0]).toMatchObject({ line: 'Native Intelligence reverted an edit to Positioning in Product' })
  })

  it('a person reverting from the history logs no digest line', async () => {
    const edited = DOC.replace('Vs spreadsheets.', 'Vs notebooks.')
    const c = docClient({ contents: [edited], revisions: [{ revision_number: 4, content: edited, edit_meta: { section: 'Positioning' } }, { revision_number: 3, content: DOC, edit_meta: null }] })
    await revertSectionEdit(c as never, { workspaceId: 'w', userId: 'u', documentId: 'd1', revision: 4, source: 'human' })
    expect(c.writes[0].edit_source).toBe('human')
    expect(logs.lines).toHaveLength(0)
  })

  it('a change across sections is not revertable alone', async () => {
    const both = DOC.replace('Vs spreadsheets.', 'A').replace('Plain.', 'B')
    const c = docClient({ contents: [both], revisions: [{ revision_number: 4, content: both, edit_meta: null }, { revision_number: 3, content: DOC, edit_meta: null }] })
    expect(await revertSectionEdit(c as never, { workspaceId: 'w', userId: 'u', documentId: 'd1', revision: 4 })).toMatchObject({ ok: false, reason: 'not_section' })
  })
})

describe('section-diff', () => {
  it('names the one section a change touched', () => {
    expect(changedSection(DOC, DOC.replace('Plain.', 'Loud.'))).toBe('Voice')
    expect(changedSection(DOC, DOC.replace('Plain.', 'Loud.').replace('Meeting', 'Call'))).toBeNull()
    expect(changedSection(DOC, DOC)).toBeNull()
  })

  it('a section renamed or removed AFTER the edit is not put back (no stale copy)', () => {
    const edited = DOC.replace('Vs spreadsheets.', 'Vs notebooks.')
    const renamed = edited.replace('## Positioning', '## Where we fit')
    expect(putSectionBack(renamed, DOC, edited, 'Positioning')).toBeNull()
  })

  it('puts a removed section back after the one it followed, and takes an added one out', () => {
    const removed = DOC.replace('## Positioning\nVs spreadsheets.\n\n', '')
    expect(putSectionBack(removed, DOC, removed, 'Positioning')).toContain('## What the product is\nMeeting capture.\n\n## Positioning\n')
    const added = `${DOC}\n## Pricing\n$20.\n`
    expect(putSectionBack(added, DOC, added, 'Pricing')).not.toContain('Pricing')
  })
})

describe('what the history keeps of a source (S6)', () => {
  it('an email keeps only its domain; no note; a web page keeps its address', () => {
    const meta = canonEditMeta({
      section: 'Positioning',
      op: 'append',
      sources: [
        { kind: 'email', from: 'dana@Northwind.example', note: 'she said we are pricey' },
        { kind: 'capture', id: 'c1', note: 'minute 12' },
        { kind: 'web', url: 'https://x.example/p' },
      ],
    })
    expect(meta.sources).toEqual([{ kind: 'email', domain: 'northwind.example' }, { kind: 'capture', id: 'c1' }, { kind: 'web', url: 'https://x.example/p' }])
    expect(canonEditMeta({ section: 'S', op: 'append', sources: [{ kind: 'email', from: 'Dana <dana@Northwind.example>' }] }).sources).toEqual([{ kind: 'email', domain: 'northwind.example' }])
    expect(JSON.stringify(meta)).not.toContain('dana@')
  })
})

describe('apply with undo: outside text is a label, never a hold (decision 16)', () => {
  it('an outside-sourced edit applies, with its label on the revision and on its digest line', async () => {
    const c = docClient({ contents: [DOC] })
    const r = await applyCanonSectionEdit(c as never, {
      workspaceId: 'w',
      userId: 'u',
      documentId: 'd1',
      key: 'product',
      section: 'Positioning',
      op: 'append',
      text: 'Cheaper than Gong.',
      reason: 'A competitor page says so',
      sources: [{ kind: 'web', url: 'https://www.gong.example/pricing' }],
      outside: 'a web page on gong.example',
    })
    expect(r).toMatchObject({ ok: true, section: 'Positioning' })
    expect(c.writes[0]).toMatchObject({ edit_meta: { section: 'Positioning', op: 'append', outside: 'a web page on gong.example' } })
    expect(logs.lines[0]).toMatchObject({ kind: 'doc_updated', line: 'Native Intelligence updated Positioning in Product (from a web page on gong.example)' })
  })

  it('an edit resting on nothing outside has no label', async () => {
    const c = docClient({ contents: [DOC] })
    await applyCanonSectionEdit(c as never, { workspaceId: 'w', userId: 'u', documentId: 'd1', key: 'product', section: 'Positioning', op: 'replace', text: 'Vs notebooks.' })
    expect(c.writes[0].edit_meta).not.toHaveProperty('outside')
    expect(logs.lines[0].line).toBe('Native Intelligence updated Positioning in Product')
  })

  it("a batch resting on outside text gets its own labelled line that day, never folded into the day's other line", async () => {
    const c = docClient({ contents: [DOC] })
    const base = { workspaceId: 'w', userId: 'u', documentId: 'd1', title: 'Product', sections: ['Positioning'], canon: { key: 'product', createdBy: 'm1' }, day: '2026-10-20' }
    await appendCanonBatchDigestLine(c as never, base)
    await appendCanonBatchDigestLine(c as never, { ...base, outside: 'outside text' })
    const mine = logs.lines.filter((l) => l.userId === 'u')
    expect(mine.map((l) => l.dedupeKey)).toEqual(['doc:d1:day:2026-10-20', 'doc:d1:day:2026-10-20:outside'])
    expect(mine[1].line).toBe('Native Intelligence updated Positioning in Product (from outside text)')
  })

  it('the module has no way to hold an edit or raise a card any more', () => {
    for (const gone of ['holdCanonEdit', 'heldEditFromPayload', 'heldEditCopy', 'heldEditRunKey', 'CANON_CARD_TTL_MS']) expect(Object.keys(canonEdit)).not.toContain(gone)
  })
})
