/**
 * Delivering a connector's validated items (F3, deliver-connector.ts): post
 * cards with the open-draft budget, section edits applied as one batch with
 * one digest line (labelled, never held, when the run read outside text),
 * email drafts on the automatic path. A dry run delivers nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  resolveCanonDocument: vi.fn(),
  loadDocumentAccess: vi.fn(),
  applyCanonSectionEdit: vi.fn(),
  appendCanonBatchDigestLine: vi.fn(async (..._args: unknown[]) => {}),
  classifyCanonSources: vi.fn(async () => ['trusted']),
  createEmailDraft: vi.fn(),
}))

vi.mock('@/lib/documents/canon-doc', () => ({ resolveCanonDocument: h.resolveCanonDocument }))
vi.mock('@/lib/documents/access', () => ({
  loadDocumentAccess: h.loadDocumentAccess,
  documentUpdateRefusal: (access: { canEdit?: boolean }) => (access.canEdit ? null : 'Only the creator or an admin can edit this document.'),
}))
vi.mock('@/lib/documents/canon-edit', () => ({
  applyCanonSectionEdit: h.applyCanonSectionEdit,
  appendCanonBatchDigestLine: h.appendCanonBatchDigestLine,
}))
vi.mock('@/lib/documents/canon-sources', async (orig) => ({
  ...(await orig<typeof import('@/lib/documents/canon-sources')>()),
  classifyCanonSources: h.classifyCanonSources,
}))
vi.mock('@/lib/safety/outside-text', () => ({ knownOrOwnSenders: async (_s: unknown, a: { addresses: string[] }) => new Set(a.addresses.filter((x) => x.endsWith('@acme.com'))) }))
vi.mock('@/lib/ai/tools/email', () => ({
  createEmailTools: (...args: unknown[]) => ({ create_email_draft: { execute: (input: unknown) => h.createEmailDraft(input, args) } }),
}))

const { deliverConnectorItems } = await import('../deliver-connector')

/** A service client whose insert_post_draft_card behaves as migration 397's: cap on open, unexpired post cards; ids dedupe. */
function fakeSupabase(opts: { openPosts?: number; rpcError?: { message: string } } = {}) {
  const inserts: Array<Record<string, unknown>> = []
  let open = opts.openPosts ?? 0
  const client = {
    rpc: async (name: string, args: { p_card: Record<string, unknown>; p_cap: number }) => {
      if (name !== 'insert_post_draft_card') return { data: null, error: { message: `no rpc ${name}` } }
      if (opts.rpcError) return { data: null, error: opts.rpcError }
      if (open >= args.p_cap) return { data: 'full', error: null }
      if (inserts.some((r) => r.id && r.id === args.p_card.id)) return { data: 'duplicate', error: null }
      inserts.push({ kind: 'question', ...args.p_card })
      open++
      return { data: 'inserted', error: null }
    },
  }
  return { client: client as never, inserts }
}

const base = {
  workspaceId: 'ws-1',
  runAsUserId: 'user-1',
  memberId: 'member-1',
  runKey: 'fire-1',
  flowId: 'flow-1',
  captureId: '22222222-2222-4222-8222-222222222222',
  captureTitle: 'Acme sync',
  skillName: 'Weekly posts',
  readOutside: false,
}

const post = (text: string) => ({ text, chars: [...text].length, limit: 280, based_on: 'GEN-42 shipped', notes: [] })

beforeEach(() => {
  vi.clearAllMocks()
  h.classifyCanonSources.mockResolvedValue(['trusted'])
})

describe('post_drafts', () => {
  it('lands one For you question card per post, with the draft on its payload and a 7-day age-out', async () => {
    const { client, inserts } = fakeSupabase()
    const out = await deliverConnectorItems('post_drafts', [post('We shipped calendar sync.'), post('Time zones are hard.')], { ...base, supabase: client, surface: 'x' })
    expect(out).toMatchObject({ to: 'post_drafts', delivered: 2, refused: [], summary: '2 X posts for you' })
    expect(inserts).toHaveLength(2)
    const card = inserts[0]
    expect(card).toMatchObject({ kind: 'question', member_id: 'member-1', workspace_id: 'ws-1', run_key: 'fire-1' })
    expect(card.title).toBe('Post on X: “We shipped calendar sync.”')
    expect((card.payload as Record<string, unknown>).post_draft).toMatchObject({ text: 'We shipped calendar sync.', surface: 'x', limit: 280 })
    expect(card.capture_id).toBe(base.captureId)
    // A retried step lands the SAME card: its id is derived from the fire and the text.
    expect(typeof card.id).toBe('string')
    const again = fakeSupabase()
    await deliverConnectorItems('post_drafts', [post('We shipped calendar sync.')], { ...base, supabase: again.client })
    expect(again.inserts[0].id).toBe(card.id)
    const ttl = Date.parse(card.expires_at as string) - Date.now()
    expect(ttl).toBeGreaterThan(6.9 * 86_400_000)
  })

  it('at most 3 posts wait at once, counted and inserted atomically: the rest are refused, never queued', async () => {
    const { client, inserts } = fakeSupabase({ openPosts: 2 })
    const out = await deliverConnectorItems('post_drafts', [post('One'), post('Two')], { ...base, supabase: client })
    expect(inserts).toHaveLength(1)
    expect(out.delivered).toBe(1)
    expect(out.refused).toEqual(['3 posts are already waiting'])
  })

  it('a duplicate insert (a retry) is not counted twice and is not an error', async () => {
    const { client } = fakeSupabase()
    await deliverConnectorItems('post_drafts', [post('One')], { ...base, supabase: client })
    const again = await deliverConnectorItems('post_drafts', [post('One')], { ...base, supabase: client })
    expect(again).toMatchObject({ delivered: 0, refused: [] })
  })

  it('nothing worth posting writes nothing (hide empty widgets)', async () => {
    const { client, inserts } = fakeSupabase()
    const out = await deliverConnectorItems('post_drafts', [], { ...base, supabase: client })
    expect(inserts).toHaveLength(0)
    expect(out.summary).toBe('Nothing worth posting')
  })

  it('a dry run (test_flow) writes nothing and says what it would do', async () => {
    const { client, inserts } = fakeSupabase()
    const out = await deliverConnectorItems('post_drafts', [post('One')], { ...base, supabase: client, dryRun: true })
    expect(inserts).toHaveLength(0)
    expect(out).toMatchObject({ dry_run: true, delivered: 0, summary: 'Test: would deliver 1 X post as For you cards' })
  })
})

describe('doc_proposals', () => {
  const doc = { id: 'doc-1', title: 'Product', content: '## Positioning\n\n## Messaging\n', created_by: 'member-owner' }
  const edit = (section: string) => ({ section, op: 'append' as const, text: `A line for ${section}.`, reason: 'From the Acme call', removes: null })

  beforeEach(() => {
    h.resolveCanonDocument.mockResolvedValue({ ok: true, doc, memberId: 'member-1', viaPointer: false })
    h.loadDocumentAccess.mockResolvedValue({ access: { canEdit: true } })
    h.applyCanonSectionEdit.mockImplementation(async (_s: unknown, args: { section: string }) => ({ ok: true, section: args.section, revision: 3 }))
  })

  it('applies the batch with no per-edit line, then ONE digest line for the document', async () => {
    const { client } = fakeSupabase()
    const out = await deliverConnectorItems('doc_proposals', [edit('Positioning'), edit('Messaging')], { ...base, supabase: client, docKey: 'product' })
    expect(h.applyCanonSectionEdit).toHaveBeenCalledTimes(2)
    for (const call of h.applyCanonSectionEdit.mock.calls) {
      expect(call[1]).toMatchObject({ logLine: false, userId: 'user-1', key: 'product', sources: [{ kind: 'capture', id: base.captureId }] })
    }
    expect(h.appendCanonBatchDigestLine).toHaveBeenCalledTimes(1)
    expect(h.appendCanonBatchDigestLine.mock.calls[0][1]).toMatchObject({ documentId: 'doc-1', sections: ['Positioning', 'Messaging'], outside: null })
    expect(out).toMatchObject({ delivered: 2, summary: 'Updated Positioning, Messaging in Product' })
  })

  it('a run that read outside text APPLIES its edits, labelled on each revision and on the digest line, with no card', async () => {
    const { client, inserts } = fakeSupabase()
    const out = await deliverConnectorItems('doc_proposals', [edit('Positioning')], { ...base, supabase: client, docKey: 'product', readOutside: true })
    expect(h.applyCanonSectionEdit).toHaveBeenCalledTimes(1)
    expect(h.applyCanonSectionEdit.mock.calls[0][1]).toMatchObject({ section: 'Positioning', outside: 'outside text', logLine: false })
    expect(h.appendCanonBatchDigestLine.mock.calls[0][1]).toMatchObject({ documentId: 'doc-1', sections: ['Positioning'], outside: 'outside text' })
    expect(out).toMatchObject({ delivered: 1, summary: 'Updated Positioning in Product (from outside text)' })
    expect(out).not.toHaveProperty('held')
    expect(inserts).toHaveLength(0)
  })

  it('an edit naming a web page is labelled by its domain', async () => {
    h.classifyCanonSources.mockResolvedValue(['outside'])
    const { client } = fakeSupabase()
    await deliverConnectorItems('doc_proposals', [edit('Positioning')], { ...base, supabase: client, docKey: 'product', sources: [{ kind: 'web', url: 'https://www.gong.example/pricing' }] })
    expect(h.applyCanonSectionEdit.mock.calls[0][1]).toMatchObject({ outside: 'a web page on gong.example' })
  })

  it('an owner who may not edit the document changes nothing, says why in plain words, and raises no card', async () => {
    h.loadDocumentAccess.mockResolvedValue({ access: { canEdit: false } })
    const { client, inserts } = fakeSupabase()
    const out = await deliverConnectorItems('doc_proposals', [edit('Positioning')], { ...base, supabase: client, docKey: 'product' })
    expect(h.applyCanonSectionEdit).not.toHaveBeenCalled()
    expect(out.refused[0]).toBe('Only admins can change the product doc.')
    expect(inserts).toHaveLength(0)
  })

  it('no such canon document: nothing delivered, and it says why', async () => {
    h.resolveCanonDocument.mockResolvedValue({ ok: false, reason: 'not_found' })
    const { client } = fakeSupabase()
    const out = await deliverConnectorItems('doc_proposals', [edit('Positioning')], { ...base, supabase: client, docKey: 'brand' })
    expect(out.summary).toBe('Nothing delivered: there is no canon document `brand`')
  })

  it('a refused edit (over budget, no such section) is recorded, the rest still land', async () => {
    h.applyCanonSectionEdit.mockImplementation(async (_s: unknown, args: { section: string }) =>
      args.section === 'Voice' ? { ok: false, reason: 'invalid', error: 'No section "Voice".' } : { ok: true, section: args.section, revision: 4 },
    )
    const { client } = fakeSupabase()
    const out = await deliverConnectorItems('doc_proposals', [edit('Voice'), edit('Messaging')], { ...base, supabase: client, docKey: 'product' })
    expect(out.delivered).toBe(1)
    expect(out.refused).toEqual(['Voice: No section "Voice".'])
  })
})

describe('email_drafts', () => {
  /** The reads the recipient check makes: the call's participants, and contacts created since the run started. */
  function mailDb(opts: { participants?: string[]; recentContacts?: string[] } = {}) {
    return {
      from: (table: string) => {
        const c: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'gte', 'in', 'overlaps']) c[m] = () => c
        c.limit = async () =>
          table === 'capture_participant'
            ? { data: (opts.participants ?? []).map((e) => ({ external_email: e })), error: null }
            : { data: (opts.recentContacts ?? []).map((e) => ({ email: e, secondary_emails: [] })), error: null }
        return c
      },
    } as never
  }

  it('a contact the run itself just made does not vouch for a recipient (review R4)', async () => {
    h.createEmailDraft.mockResolvedValue({ success: true })
    const out = await deliverConnectorItems('email_drafts', [{ to: ['new@acme.com'], cc: [], subject: 's', body: 'b' }], { ...base, supabase: mailDb({ recentContacts: ['new@acme.com'] }), runStartedAt: new Date().toISOString() })
    expect(out.delivered).toBe(0)
    expect(out.refused[0]).toMatch(/new@acme.com: not a contact/)
  })

  it("refuses a recipient the person isn't in touch with (review S9); a call participant counts", async () => {
    h.createEmailDraft.mockResolvedValue({ success: true })
    const client = mailDb({ participants: ['Guest@Partner.io'] })
    const out = await deliverConnectorItems(
      'email_drafts',
      [
        { to: ['attacker@evil.example'], cc: [], subject: 's', body: 'b' },
        { to: ['guest@partner.io'], cc: [], subject: 's', body: 'b' },
      ],
      { ...base, supabase: client },
    )
    expect(out.delivered).toBe(1)
    expect(out.refused[0]).toMatch(/attacker@evil.example: not a contact/)
    expect(h.createEmailDraft).toHaveBeenCalledTimes(1)
  })

  it('writes each through the automatic draft path (cap and checks hold), never a send', async () => {
    h.createEmailDraft.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false, error: "Today's limit of automatic drafts is reached" })
    const client = mailDb()
    const out = await deliverConnectorItems(
      'email_drafts',
      [
        { to: ['ana@acme.com'], cc: [], subject: 'It shipped', body: 'Hi Ana' },
        { to: ['bo@acme.com'], cc: [], subject: 'It shipped', body: 'Hi Bo' },
      ],
      { ...base, supabase: client },
    )
    // createEmailTools(userId, workspaceId, strictWorkspace, policy, automaticDrafts=true)
    expect(h.createEmailDraft.mock.calls[0][1]).toEqual(['user-1', 'ws-1', true, 'session', true])
    expect(h.createEmailDraft.mock.calls[0][0]).toEqual({ to: ['ana@acme.com'], subject: 'It shipped', body: 'Hi Ana' })
    expect(out.delivered).toBe(1)
    expect(out.refused[0]).toMatch(/bo@acme.com: Today's limit/)
  })

  describe('"you asked, we shipped": no pile-up (P9 review S7)', () => {
    /** mailDb plus this loop's earlier drafts (email_draft rows stamped with the loop), and the stamps it writes. */
    function loopDb(drafts: Array<{ to: string; at: string; status?: string }>, opts: { failRead?: boolean } = {}) {
      const stamps: Array<Record<string, unknown>> = []
      const client = {
        from: (table: string) => {
          const c: Record<string, unknown> = {}
          let status: unknown[] | null = null
          for (const m of ['select', 'eq', 'gte', 'overlaps']) c[m] = () => c
          c.in = (k: string, v: unknown[]) => {
            if (k === 'status') status = v
            return c
          }
          c.update = (patch: Record<string, unknown>) => {
            stamps.push(patch)
            return c
          }
          c.limit = async () => {
            if (table === 'email_draft') {
              if (opts.failRead) return { data: null, error: { message: 'down' } }
              const rows = drafts.filter((d) => !status || status.includes(d.status ?? 'sent'))
              return { data: rows.map((d) => ({ to_emails: [d.to], cc_emails: [], created_at: d.at })), error: null }
            }
            return { data: [], error: null }
          }
          return c
        },
      } as never
      return { client, stamps }
    }
    const reach = { ...base, perFlowNotes: true }
    const note = (to: string) => ({ to: [to], cc: [], subject: 'It shipped', body: 'Hi' })

    it('skips a person this loop already wrote to (waiting, or in the last 14 days), and stamps what it writes', async () => {
      h.createEmailDraft.mockResolvedValue({ success: true, draft_id: 'prov-1' })
      const { client, stamps } = loopDb([{ to: 'ana@acme.com', at: new Date(Date.now() - 3 * 86_400_000).toISOString() }])
      const out = await deliverConnectorItems('email_drafts', [note('ana@acme.com'), note('bo@acme.com')], { ...reach, supabase: client })
      expect(out.delivered).toBe(1)
      expect(out.refused[0]).toMatch(/ana@acme.com: they already have a note from this loop/)
      expect(stamps).toEqual([{ metadata: { origin: 'automatic', flow_id: 'flow-1' } }])
    })

    it('at most 10 notes a day from one loop', async () => {
      h.createEmailDraft.mockResolvedValue({ success: true, draft_id: 'prov-x' })
      const today = new Date().toISOString()
      const { client } = loopDb(Array.from({ length: 9 }, (_, i) => ({ to: `p${i}@acme.com`, at: today })))
      const out = await deliverConnectorItems('email_drafts', [note('x1@acme.com'), note('x2@acme.com')], { ...reach, supabase: client })
      expect(out.delivered).toBe(1)
      expect(out.refused).toContain('more than 10 notes from this loop today')
    })

    it('earlier drafts that can’t be read: nothing is written (fails closed)', async () => {
      const { client } = loopDb([], { failRead: true })
      const out = await deliverConnectorItems('email_drafts', [note('ana@acme.com')], { ...reach, supabase: client })
      expect(out.delivered).toBe(0)
      expect(h.createEmailDraft).not.toHaveBeenCalled()
    })
  })
})
