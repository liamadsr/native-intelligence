/**
 * propose_section_edit (D2, decision 16 as Liam settled it: apply with undo):
 * every edit the caller may make applies at once; one that rests on outside
 * text (an outside source, or a run that read outside text) applies too,
 * labelled so for the history and the digest; a caller who may not edit the
 * document is refused with a plain message. No path raises a card.
 * revert_section_edit undoes one edit by key or id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  mayEdit: true,
  outsideReads: false,
  applied: [] as Array<Record<string, unknown>>,
  reverted: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/documents/canon-doc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/canon-doc')>()),
  resolveCanonDocument: vi.fn(async () => ({ ok: true, memberId: 'm1', viaPointer: false, doc: { id: 'doc-1', title: 'Product', content: '## Positioning\nVs spreadsheets.\n', revision: 3, created_by: 'm9', canon_key: 'product' } })),
}))
vi.mock('@/lib/documents/canon-registry', () => ({ loadCanonRegistry: vi.fn(async () => []) }))
vi.mock('@/lib/documents/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/access')>()),
  loadDocumentAccess: vi.fn(async () => ({ access: { role: state.mayEdit ? 'admin' : 'member', memberId: 'm1', isProductDoc: true, row: { id: 'doc-1', created_by: 'm9', type: 'note', published_status: 'published', canon_key: 'product', visibility: 'workspace' } }, error: null })),
}))
vi.mock('@/lib/documents/canon-sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/canon-sources')>()),
  turnOutsideReads: vi.fn(async (_s: unknown, c: { attended: boolean; runId?: string | null }) =>
    c.runId ? { read: state.outsideReads, tools: state.outsideReads ? ['web_fetch'] : [] } : { read: !c.attended, tools: [] },
  ),
  classifyCanonSources: vi.fn(async (_s: unknown, sources: Array<{ kind: string }>) => sources.map((s) => (s.kind === 'capture' ? 'trusted' : s.kind === 'email' || s.kind === 'web' ? 'outside' : 'unverified'))),
}))
vi.mock('@/lib/documents/canon-edit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/canon-edit')>()),
  applyCanonSectionEdit: vi.fn(async (_s: unknown, args: Record<string, unknown>) => {
    state.applied.push(args)
    return { ok: true, documentId: 'doc-1', revision: 4, section: 'Positioning', before: '', after: '', rebased: false, title: 'Product' }
  }),
  revertSectionEdit: vi.fn(async (_s: unknown, args: Record<string, unknown>) => {
    state.reverted.push(args)
    return { ok: true, revision: 5, section: 'Positioning', laterChangesToSection: false }
  }),
}))

// The product doc's graded claims (marketing M0): what the edit's sources show, counted.
const evidence = vi.hoisted(() => ({ fn: vi.fn(async () => ({ companies: 1, documents: 0, metrics: 0 })) }))
vi.mock('@/lib/marketing/claim-evidence', () => ({ evidenceFromSources: evidence.fn }))

import * as canonTools from '../canon'
import { createCanonTools } from '../canon'
import { canonEditForbidden } from '@/lib/documents/canon'

const OPTS = { toolCallId: 't', messages: [] } as never
type Result = Record<string, unknown> & { success: boolean; error?: string }

const edit = (input: Record<string, unknown>, ctx: Record<string, unknown> = { attended: true }) =>
  createCanonTools('u1', {} as never, 'ws-1', ctx as never).propose_section_edit.execute!(
    { key: 'product', section: 'Positioning', op: 'append', text: 'Cheaper than Gong.', reason: 'Said on a call', ...input } as never,
    OPTS,
  ) as Promise<Result>

beforeEach(() => {
  state.mayEdit = true
  state.outsideReads = false
  state.applied = []
  state.reverted = []
})

describe('propose_section_edit', () => {
  it('applies at once from a call, with its reason and sources, and no label', async () => {
    const r = await edit({ sources: [{ kind: 'capture', id: 'c1' }], base_revision: 3 })
    expect(r).toMatchObject({ success: true, revision: 4, section: 'Positioning' })
    expect(r).not.toHaveProperty('outside')
    expect(state.applied[0]).toMatchObject({ documentId: 'doc-1', op: 'append', reason: 'Said on a call', sources: [{ kind: 'capture', id: 'c1' }], baseRevision: 3, outside: null })
  })

  it('applies at once from the chat with no sources named (the person is the source)', async () => {
    expect(await edit({})).toMatchObject({ success: true })
    expect(state.applied).toHaveLength(1)
  })

  it('an edit whose only source is an unknown email APPLIES, labelled by its domain only', async () => {
    const r = await edit({ sources: [{ kind: 'email', from: 'x@y.example' }] })
    expect(r).toMatchObject({ success: true, revision: 4, outside: 'an outside email from y.example' })
    expect(r).not.toHaveProperty('held')
    expect(String(r.message)).toContain('labelled as from an outside email from y.example')
    expect(state.applied[0]).toMatchObject({ outside: 'an outside email from y.example' })
    expect(JSON.stringify(state.applied[0].outside)).not.toContain('x@')
  })

  it('a run that read outside text applies whatever it cites, labelled from what it read (B2)', async () => {
    state.outsideReads = true
    const ctx = { attended: false, outsideReadsRunId: 'run-1' }
    expect(await edit({}, ctx)).toMatchObject({ success: true, outside: 'a web page' })
    expect(await edit({ sources: [{ kind: 'capture', id: 'c1' }] }, ctx)).toMatchObject({ success: true, outside: 'a web page' })
    expect(state.applied.map((a) => a.outside)).toEqual(['a web page', 'a web page'])
  })

  it("a run's follow-up chat turn is labelled from the run's outside reads too (B4)", async () => {
    state.outsideReads = true
    expect(await edit({ sources: [{ kind: 'capture', id: 'c1' }] }, { attended: true, outsideReadsRunId: 'run-1' })).toMatchObject({ success: true, outside: 'a web page' })
  })

  it('an unattended run with no outside reads has no label; one with no run to check is labelled (fail closed)', async () => {
    expect(await edit({ sources: [{ kind: 'capture', id: 'c1' }] }, { attended: false, outsideReadsRunId: 'run-1' })).toMatchObject({ success: true, revision: 4 })
    expect(state.applied[0].outside).toBeNull()
    expect(await edit({ sources: [{ kind: 'capture', id: 'c1' }] }, { attended: false })).toMatchObject({ success: true, outside: 'outside text' })
  })

  it("a loop run's own record of its reads labels its edit (skill-run-reads.ts)", async () => {
    const readOutside = vi.fn(async () => ({ read: true, tools: ['mcp__notion__search'] }))
    expect(await edit({ sources: [{ kind: 'capture', id: 'c1' }] }, { attended: false, readOutside })).toMatchObject({ success: true, outside: 'a connected app' })
    expect(readOutside).toHaveBeenCalledOnce()
    const clean = vi.fn(async () => ({ read: false, tools: [] }))
    await edit({ sources: [{ kind: 'capture', id: 'c1' }] }, { attended: false, readOutside: clean })
    expect(state.applied.at(-1)!.outside).toBeNull()
  })

  it('a person who may not edit the document is refused in plain words, never routed to a card (#774)', async () => {
    state.mayEdit = false
    const r = await edit({ sources: [{ kind: 'capture', id: 'c1' }] })
    expect(r).toEqual({ success: false, error: "Only admins can change the product doc. Say what you'd change instead, so an admin can make the edit." })
    expect(state.applied).toHaveLength(0)
  })

  it('an unattended run that may not edit the document is refused the same way', async () => {
    state.mayEdit = false
    state.outsideReads = true
    const r = await edit({}, { attended: false, outsideReadsRunId: 'run-1' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/^Only admins can change the product doc/)
    expect(state.applied).toHaveLength(0)
  })

  it('a personal canon key names its owner in the refusal', () => {
    expect(canonEditForbidden('person:voice', 'Voice')).toBe("Only its owner can change `person:voice`. Say what you'd change instead.")
    expect(canonEditForbidden('team-playbook', 'Team playbook')).toMatch(/^Only admins can change Team playbook\./)
  })

  it('the tools module has no card key or hold left', () => {
    expect(Object.keys(canonTools)).not.toContain('accessCardKey')
  })

  it('every edit carries the budget and fixed-section check (canon-lint.ts)', async () => {
    await edit({ text: '## A heading of its own' })
    const check = state.applied[0].check as (n: { content: string; previous: string }) => string | null
    expect(check({ previous: '## Positioning\n', content: '## Positioning\n## A heading of its own' })).toContain('heading of its own')
  })

  it('needs text to replace or append', async () => {
    expect(await edit({ text: '  ' })).toMatchObject({ success: false })
  })
})

describe('revert_section_edit', () => {
  it('undoes one edit by key', async () => {
    const r = (await createCanonTools('u1', {} as never, 'ws-1').revert_section_edit.execute!({ key: 'product', revision: 4 } as never, OPTS)) as Result
    expect(r).toMatchObject({ success: true, revision: 5, section: 'Positioning' })
    expect(state.reverted[0]).toMatchObject({ documentId: 'doc-1', revision: 4, workspaceId: 'ws-1' })
  })

  it('needs a key or a document', async () => {
    const r = (await createCanonTools('u1', {} as never, 'ws-1').revert_section_edit.execute!({ revision: 4 } as never, OPTS)) as Result
    expect(r.success).toBe(false)
  })
})

describe('propose_section_edit: the product doc’s graded claims (marketing M0)', () => {
  const doc = '## Positioning\nVs spreadsheets.\n'
  type Check = (next: { previous: string; content: string }) => string | null

  it('counts the sources only for a [proven] line, never the model’s word, and the doc is never its own proof', async () => {
    evidence.fn.mockClear()
    await edit({ text: '- Teams switch from a spreadsheet [assumption]', sources: [{ kind: 'capture', id: 'c1' }] })
    expect(evidence.fn).not.toHaveBeenCalled()
    await edit({ text: '- Teams switch from a spreadsheet [proven]', sources: [{ kind: 'capture', id: 'c1' }] })
    expect(evidence.fn).toHaveBeenCalledWith(expect.anything(), 'ws-1', [{ kind: 'capture', id: 'c1' }], 'doc-1')
  })

  it('the edit’s check refuses [proven] on one company, and an ungraded claim', async () => {
    await edit({ text: '- Teams switch from a spreadsheet [proven]', sources: [{ kind: 'capture', id: 'c1' }] })
    const proven = state.applied.at(-1)!.check as Check
    expect(proven({ previous: doc, content: `${doc}- Teams switch from a spreadsheet [proven]\n` })).toMatch(/1 outside company/)
    await edit({ text: '- Teams switch from a spreadsheet' })
    const ungraded = state.applied.at(-1)!.check as Check
    expect(ungraded({ previous: doc, content: `${doc}- Teams switch from a spreadsheet\n` })).toMatch(/carries its grade/)
  })

  it('a web-research edit applies with the same check, labelled from the page', async () => {
    await edit({ text: '- Gong files no actions [plausible]', sources: [{ kind: 'web', url: 'https://www.gong.io/product' }] })
    expect(state.applied).toHaveLength(1)
    expect(state.applied[0].outside).toBe('a web page on gong.io')
    const check = state.applied[0].check as Check
    expect(check({ previous: doc, content: `${doc}- Gong files no actions [plausible]\n` })).toBeNull()
  })
})
