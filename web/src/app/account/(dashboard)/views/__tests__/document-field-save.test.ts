/**
 * The document panel's field saves (document-field-save.ts): an optimistic
 * change shown at once is rolled back when the PATCH fails (a 403 since
 * migration 359: a member moving a shared page into a project), and the
 * server's error comes back to show, for every field.
 */
import { describe, expect, it, vi } from 'vitest'
import { merge3 } from '@/lib/documents/line-diff'
import { composeSectionChoice, conflictingSections, patchDocumentFields, planConflict, planSectionConflict, rollbackPatch, snapshotKeys, unmountAction } from '../document-field-save'

const doc = { id: 'd', title: 'Plan', project_id: null as string | null, project_name: null as string | null }

describe('optimistic rollback', () => {
  it('restores the keys the patch changed', () => {
    const patch = { project_id: 'p-1', project_name: 'Launch' }
    const before = snapshotKeys(doc, patch)
    expect(before).toEqual({ project_id: null, project_name: null })
    const shown = { ...doc, ...patch }
    expect(rollbackPatch(shown, before, patch)).toEqual(doc)
  })

  it('leaves a key a later change already replaced', () => {
    const patch = { project_id: 'p-1', project_name: 'Launch' }
    const before = snapshotKeys(doc, patch)
    const later = { ...doc, ...patch, project_id: 'p-2', project_name: 'Other' }
    expect(rollbackPatch(later, before, patch)).toEqual(later)
  })
})

describe('patchDocumentFields', () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

  it('PATCHes the fields and hands back the saved row', async () => {
    const f = respond(200, { document: { id: 'd', title: 'New' } })
    expect(await patchDocumentFields('d', { title: 'New' }, f)).toEqual({ ok: true, document: { id: 'd', title: 'New' } })
    expect(f).toHaveBeenCalledWith('/api/account/documents/d', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'New' }) }))
  })

  it('a refusal carries the server line', async () => {
    const f = respond(403, { error: 'Only the creator or an admin can edit this document.', code: 'FORBIDDEN' })
    expect(await patchDocumentFields('d', { project_id: 'p-1' }, f)).toEqual({
      ok: false,
      status: 403,
      error: 'Only the creator or an admin can edit this document.',
      code: 'FORBIDDEN',
    })
  })

  it('a failure without a body, or a network error, still says it did not save', async () => {
    const empty = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch
    expect(await patchDocumentFields('d', { content: 'x' }, empty)).toMatchObject({ ok: false, status: 500, error: expect.stringMatching(/save/) })
    const down = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await patchDocumentFields('d', { content: 'x' }, down)).toMatchObject({ ok: false, status: 0 })
  })
})

describe('planConflict: a save that lost the compare-and-swap (migration 364)', () => {
  const base = '# Plan\n\n## Goals\nShip it.\n\n## Risks\nNone yet.'
  const agent = base.replace('None yet.', 'Vendor delay.')

  it('the person typed on top of the agent edit the editor already showed: save it', () => {
    const mine = agent.replace('Ship it.', 'Ship it now.')
    expect(planConflict(base, mine, agent, merge3)).toEqual({ kind: 'save', text: mine })
  })

  it('the editor never showed the agent edit, different lines: offer to keep both', () => {
    const mine = base.replace('Ship it.', 'Ship it now.')
    expect(planConflict(base, mine, agent, merge3)).toEqual({ kind: 'combine', text: agent.replace('Ship it.', 'Ship it now.') })
  })

  it('both changed the same section: the person picks that section (minimal D4)', () => {
    const plan = planConflict(base, base.replace('None yet.', 'Mine.'), agent, merge3)
    expect(plan.kind).toBe('sections')
    expect(plan.kind === 'sections' && conflictingSections(plan.parts).map((c) => c.heading)).toEqual(['Risks'])
  })

  it('the sections no longer line up (one added): the person picks the whole text', () => {
    const mine = `${base.replace('None yet.', 'Mine.')}\n\n## Extra\nNew.`
    expect(planConflict(base, mine, agent, merge3)).toEqual({ kind: 'choose' })
  })

  it('the same text on both sides needs no question', () => {
    expect(planConflict(base, agent, agent, merge3)).toEqual({ kind: 'save', text: agent })
  })
})

describe('patchDocumentFields: a 409 carries its code and details', () => {
  it('passes the conflict through to the panel', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'This document changed since you read it.', code: 'CONFLICT', details: { revision: 7 } }), {
        status: 409,
      })) as unknown as typeof fetch
    expect(await patchDocumentFields('doc-1', { content: 'x', base_revision: 6 }, fetchImpl)).toEqual({
      ok: false,
      status: 409,
      error: 'This document changed since you read it.',
      code: 'CONFLICT',
      details: { revision: 7 },
    })
  })
})

describe('unmountAction: closing the panel never drops the text', () => {
  it('a conflict open: the text becomes the draft, whatever is queued', () => {
    expect(unmountAction({ text: 'mine', conflictOpen: true, saveQueued: false })).toBe('draft')
    expect(unmountAction({ text: 'mine', conflictOpen: true, saveQueued: true })).toBe('draft')
  })

  it('a save still queued: it is flushed; nothing queued: nothing to do', () => {
    expect(unmountAction({ text: 'mine', conflictOpen: false, saveQueued: true })).toBe('save')
    expect(unmountAction({ text: 'mine', conflictOpen: false, saveQueued: false })).toBeNull()
    expect(unmountAction({ text: null, conflictOpen: true, saveQueued: true })).toBeNull()
  })
})

describe('a section-level conflict (minimal D4)', () => {
  const base = '# Product\n\n## Positioning\nVs spreadsheets.\nCheap.\n\n## Voice\nPlain.\nShort.'
  // Dial8 rewrote Positioning and Voice; the person rewrote Positioning and the title.
  const theirs = base.replace('Vs spreadsheets.\nCheap.', 'Vs notebooks.\nFast.').replace('Plain.\nShort.', 'Warm.\nShort.')
  const mine = base.replace('Vs spreadsheets.\nCheap.', 'Vs paper.\nCheap.').replace('# Product', '# Product doc')

  it('takes each side’s own changes and leaves only the shared section to the person', () => {
    const parts = planSectionConflict(base, mine, theirs)!
    const [conflict] = conflictingSections(parts)
    expect(conflict.heading).toBe('Positioning')
    const keepMine = composeSectionChoice(parts, { [conflict.key]: 'mine' })
    expect(keepMine).toBe('# Product doc\n\n## Positioning\nVs paper.\nCheap.\n\n## Voice\nWarm.\nShort.')
    const takeTheirs = composeSectionChoice(parts, { [conflict.key]: 'theirs' })
    expect(takeTheirs).toContain('Vs notebooks.\nFast.')
    expect(takeTheirs.startsWith('# Product doc')).toBe(true)
  })

  it('a renamed section does not line up', () => {
    expect(planSectionConflict(base, mine.replace('## Voice', '## Tone'), theirs)).toBeNull()
  })

  it('a ## inside a code fence is not a section', () => {
    const fenced = 'Intro\n```\n## not a heading\n```\n\n## Real\nx'
    expect(conflictingSections(planSectionConflict(fenced, fenced.replace('x', 'mine'), fenced.replace('x', 'theirs'))!).map((c) => c.heading)).toEqual(['Real'])
  })

  it('a document that starts with a heading comes back without a blank first line (nit)', () => {
    const doc = '## A\nx\n\n## B\ny'
    const parts = planSectionConflict(doc, doc.replace('x', 'mine'), doc.replace('x', 'theirs'))!
    const [c] = conflictingSections(parts)
    expect(composeSectionChoice(parts, { [c.key]: 'mine' })).toBe('## A\nmine\n\n## B\ny')
  })

  it('two sections with the same heading are chosen apart (nit)', () => {
    const doc = '## Notes\na\n\n## Notes\nb'
    const parts = planSectionConflict(doc, doc.replace('a', 'A1').replace('b', 'B1'), doc.replace('a', 'A2').replace('b', 'B2'))!
    const both = conflictingSections(parts)
    expect(both.map((c) => c.heading)).toEqual(['Notes', 'Notes'])
    expect(new Set(both.map((c) => c.key)).size).toBe(2)
    expect(composeSectionChoice(parts, { [both[0].key]: 'mine', [both[1].key]: 'theirs' })).toBe('## Notes\nA1\n\n## Notes\nB2')
  })
})
