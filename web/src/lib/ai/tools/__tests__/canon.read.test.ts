/**
 * read_canon (canon D1): one canon document by key, or one section of it. A
 * long one comes back as its outline; an empty template section carries what
 * belongs in it; a missing key names the keys there are; a personal key is the
 * caller's own (canon-doc.ts resolves it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  lookup: null as unknown,
  keys: [] as Array<{ key: string }>,
  calls: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/documents/canon-doc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/canon-doc')>()),
  resolveCanonDocument: vi.fn(async (_s: unknown, args: Record<string, unknown>) => {
    state.calls.push(args)
    return state.lookup
  }),
}))
vi.mock('@/lib/documents/canon-registry', () => ({ loadCanonRegistry: vi.fn(async () => state.keys) }))

import { createCanonTools } from '../canon'

const OPTS = { toolCallId: 't', messages: [] } as never
type Result = Record<string, unknown> & { success: boolean; error?: string }

function found(content: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    memberId: 'm1',
    viaPointer: false,
    doc: { id: 'doc-1', title: 'Product', content, revision: 4, updated_at: '2026-10-19T00:00:00Z', created_by: 'm1', frontmatter: {}, canon_key: 'product', ...extra },
  }
}

const read = (input: Record<string, unknown>) => createCanonTools('u1', {} as never, 'ws-1').read_canon.execute!(input as never, OPTS) as Promise<Result>

beforeEach(() => {
  state.lookup = null
  state.keys = []
  state.calls = []
})

describe('read_canon', () => {
  it('reads the whole document, with its revision, owner and the empty sections to fill', async () => {
    state.lookup = found("## What the product is\nMeeting capture.\n\n## Who it's for\n\n## Positioning\n")
    const r = await read({ key: ' Product ' })
    expect(r.success).toBe(true)
    expect(r).toMatchObject({ key: 'product', document_id: 'doc-1', revision: 4, owner: 'admins' })
    expect(r.content).toContain('Meeting capture.')
    expect((r.empty_sections as Array<{ heading: string }>).map((s) => s.heading)).toEqual(["Who it's for", 'Positioning'])
    expect(state.calls[0]).toMatchObject({ workspaceId: 'ws-1', userId: 'u1', key: 'product' })
  })

  it('reads one section by name', async () => {
    state.lookup = found('## What the product is\nMeeting capture.\n\n## Positioning\nVs spreadsheets.\n')
    const r = await read({ key: 'product', section: 'positioning' })
    expect(r).toMatchObject({ success: true, section: 'Positioning', content: '## Positioning\nVs spreadsheets.' })
  })

  it('a missing section names the sections there are', async () => {
    state.lookup = found('## What the product is\nMeeting capture.\n')
    const r = await read({ key: 'product', section: 'Pricing' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('"What the product is"')
  })

  it('a long document comes back as its outline', async () => {
    state.lookup = found(`## What the product is\n${'x'.repeat(13_000)}\n\n## Positioning\nshort\n`)
    const r = await read({ key: 'product' })
    expect(r.success).toBe(true)
    expect(r.content).toBeUndefined()
    expect((r.outline as unknown[]).length).toBe(2)
    expect(r.note).toContain('section')
  })

  it('a key with no document names the keys there are, and the template to create it from', async () => {
    state.lookup = { ok: false, reason: 'not_found' }
    state.keys = [{ key: 'product' }]
    const r = await read({ key: 'team-playbook' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('`product`')
    expect(r.error).toContain('create_canon_document')
  })

  it('refuses a malformed key without a read', async () => {
    const r = await read({ key: 'not a key' })
    expect(r.success).toBe(false)
    expect(state.calls).toHaveLength(0)
  })

  it('a personal key is said to be yours', async () => {
    state.lookup = found('## Audience\nFounders.\n', { canon_key: 'content-brief:x' })
    const r = await read({ key: 'content-brief:x' })
    expect(r).toMatchObject({ success: true, owner: 'you', personal: true })
  })
})
