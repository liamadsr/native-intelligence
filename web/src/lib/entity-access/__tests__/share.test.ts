/**
 * Share by mention (../share.ts) and its Undo (../share-toast.ts): a post
 * that names a record the channel's readers can't all see opens it to them,
 * when its author may share it, and says so; Undo deletes the grant. The
 * database's insert policy is the real check (proven on DEV); this pins what
 * the app asks for. Fixtures are made up.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { shareMentionedRecords, shareRecordsWithChannel } from '../share'
import { parseSharedRecords, toastSharedRecords, undoShare, type ShareToastDeps } from '../share-toast'
import { channelAudience, sharedToastText } from '../model'

const WS = 'aaaaaaaa-0000-4000-8000-000000000001'
const ANA = 'uuuuuuuu-0000-4000-8000-00000000000a'
const BEN = 'uuuuuuuu-0000-4000-8000-00000000000b'
const ANA_M = 'mmmmmmmm-0000-4000-8000-00000000000a' // a member
const BEN_M = 'mmmmmmmm-0000-4000-8000-00000000000b' // an admin

function db(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    member: [
      { id: ANA_M, user_id: ANA, workspace_id: WS, display_name: 'Ana Ruiz', role: 'member' },
      { id: BEN_M, user_id: BEN, workspace_id: WS, display_name: 'Ben Okafor', role: 'admin' },
    ],
    document: [
      { id: 'doc-ana', workspace_id: WS, visibility: 'private', created_by: ANA_M },
      { id: 'doc-ben', workspace_id: WS, visibility: 'private', created_by: BEN_M },
      { id: 'doc-ws', workspace_id: WS, visibility: 'workspace', created_by: ANA_M },
    ],
    captures: [
      { id: 'cap-ana', workspace_id: WS, visibility: 'private', user_id: ANA, is_eval: false },
      { id: 'cap-eval', workspace_id: WS, visibility: 'private', user_id: ANA, is_eval: true },
    ],
    contact: [
      { id: 'ct-ana', workspace_id: WS, visibility: 'private', created_by_member_id: ANA_M, company_id: 'co-closed', merged_into_contact_id: null },
      { id: 'ct-open', workspace_id: WS, visibility: 'workspace', created_by_member_id: ANA_M, company_id: 'co-open', merged_into_contact_id: null },
    ],
    company: [
      { id: 'co-closed', workspace_id: WS },
      { id: 'co-open', workspace_id: WS },
    ],
    entity_access: [],
    ...extra,
  }
  return { client: memoryDb(tables), tables }
}

const rec = (type: string, id: string, label = 'Q3 pricing') => ({ type, id, label })
const ana = { workspaceId: WS, channelId: 'ch-1', userId: ANA, memberId: ANA_M, source: 'mention' as const }

describe('shareRecordsWithChannel', () => {
  it('grants the channel view access to the author’s own private doc and capture', async () => {
    const { client, tables } = db()
    const shared = await shareRecordsWithChannel(client, { ...ana, records: [rec('document', 'doc-ana'), rec('capture', 'cap-ana', 'Fernhill call')] })
    expect(shared.map((s) => `${s.type}:${s.id}:${s.label}`).sort()).toEqual(['capture:cap-ana:Fernhill call', 'document:doc-ana:Q3 pricing'])
    expect(tables.entity_access).toHaveLength(2)
    for (const g of tables.entity_access) {
      expect(g).toMatchObject({ workspace_id: WS, grantee_kind: 'channel', grantee_channel_id: 'ch-1', level: 'view', granted_by: ANA_M, source: 'mention' })
    }
  })

  it('grants nothing for a record everyone can see, someone else’s, an eval capture, or a kind with no grants', async () => {
    const { client, tables } = db()
    const shared = await shareRecordsWithChannel(client, {
      ...ana,
      records: [rec('document', 'doc-ws'), rec('document', 'doc-ben'), rec('capture', 'cap-eval'), rec('action', 'act-1'), rec('team_chat_message', 'm-1')],
    })
    expect(shared).toEqual([])
    expect(tables.entity_access).toEqual([])
  })

  it('a restricted contact: its creator may share it; a company: only an admin, and only one no member can see', async () => {
    const asAna = db()
    expect((await shareRecordsWithChannel(asAna.client, { ...ana, records: [rec('contact', 'ct-ana'), rec('contact', 'ct-open'), rec('company', 'co-closed')] })).map((s) => s.id)).toEqual(['ct-ana'])
    const asBen = db()
    const ben = { ...ana, userId: BEN, memberId: BEN_M, source: 'channel_share' as const }
    const shared = await shareRecordsWithChannel(asBen.client, { ...ben, records: [rec('company', 'co-closed'), rec('company', 'co-open'), rec('contact', 'ct-ana')] })
    expect(shared.map((s) => s.id).sort()).toEqual(['co-closed', 'ct-ana'])
    expect(asBen.tables.entity_access.every((g) => g.source === 'channel_share')).toBe(true)
  })

  it("a call's notes named beside another record: the notes are skipped (their conversation's alone), the other is shared", async () => {
    const { client, tables } = db({
      captures: [{ id: 'cap-notes', workspace_id: WS, visibility: 'private', user_id: ANA, is_eval: false, notes_channel_id: 'ch-call' }],
    })
    const shared = await shareRecordsWithChannel(client, { ...ana, records: [rec('capture', 'cap-notes', 'Call in #launch'), rec('document', 'doc-ana')] })
    expect(shared.map((s) => s.id)).toEqual(['doc-ana'])
    expect(tables.entity_access.map((g) => g.entity_id)).toEqual(['doc-ana'])
  })

  it('leaves a record already granted to the channel alone', async () => {
    const { client, tables } = db({
      entity_access: [{ id: 'g-old', workspace_id: WS, entity_type: 'document', entity_id: 'doc-ana', grantee_kind: 'channel', grantee_channel_id: 'ch-1' }],
    })
    expect(await shareRecordsWithChannel(client, { ...ana, records: [rec('document', 'doc-ana')] })).toEqual([])
    expect(tables.entity_access).toHaveLength(1)
  })

  it('shares nothing when the database refuses (its policy is the real check)', async () => {
    const { client } = db()
    const refusing = {
      from: (table: string) => {
        if (table !== 'entity_access') return client.from(table)
        const real = client.from(table)
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'insert') {
              return () => ({ select: async () => ({ data: null, error: { message: 'new row violates row-level security policy', code: '42501' } }) })
            }
            return Reflect.get(target, prop)
          },
        })
      },
    } as never
    expect(await shareRecordsWithChannel(refusing, { ...ana, records: [rec('document', 'doc-ana')] })).toEqual([])
  })
})

describe('shareMentionedRecords', () => {
  it('names the channel it reached', async () => {
    const { client } = db()
    const out = await shareMentionedRecords(client, { ...ana, channel: { id: 'ch-1', kind: 'channel', name: 'launch' }, records: [rec('document', 'doc-ana')] })
    expect(out.shared).toHaveLength(1)
    expect(out.shared_with).toBe('#launch')
  })

  it('a DM names its other person; a note to self shares nothing', async () => {
    const { client, tables } = db()
    const dm = await shareMentionedRecords(client, { ...ana, channel: { id: 'ch-dm', kind: 'dm', name: null, dm_key: `${ANA_M}:${BEN_M}` }, records: [rec('document', 'doc-ana')] })
    expect(dm.shared_with).toBe('Ben Okafor')
    const self = await shareMentionedRecords(client, { ...ana, channel: { id: 'ch-self', kind: 'dm', name: null, dm_key: ANA_M }, records: [rec('capture', 'cap-ana')] })
    expect(self).toEqual({ shared: [], shared_with: null })
    expect(tables.entity_access.map((g) => g.grantee_channel_id)).toEqual(['ch-dm'])
  })

  it('nothing mentioned: nothing read, nothing shared', async () => {
    const from = vi.fn()
    expect(await shareMentionedRecords({ from } as never, { ...ana, channel: { id: 'ch-1', kind: 'channel', name: 'x' }, records: [] })).toEqual({ shared: [], shared_with: null })
    expect(from).not.toHaveBeenCalled()
  })
})

describe('the toast and its Undo', () => {
  const deps = () => {
    const calls: Array<{ url: string; method?: string }> = []
    const d: ShareToastDeps & { calls: typeof calls; success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } = {
      calls,
      success: vi.fn(),
      error: vi.fn(),
      fetch: async (url, init) => {
        calls.push({ url, method: init?.method })
        return new Response('{}', { status: 200 })
      },
      toast: { success: (m, o) => d.success(m, o), error: (m) => d.error(m) },
    }
    return d
  }

  it('says what was shared with whom, and Undo deletes each grant', async () => {
    const d = deps()
    const shared = [{ grant_id: 'g-1', type: 'document' as const, id: 'doc-ana', label: 'Q3 pricing' }]
    expect(toastSharedRecords(shared, '#launch', d)).toBe(true)
    expect(d.success).toHaveBeenCalledWith('Shared “Q3 pricing” with #launch', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }))
    d.success.mock.calls[0][1].action.onClick()
    await vi.waitFor(() => expect(d.calls).toEqual([{ url: '/api/account/entity-access/g-1', method: 'DELETE' }]))
    expect(d.error).not.toHaveBeenCalled()
  })

  it('no toast when nothing was shared', () => {
    const d = deps()
    expect(toastSharedRecords([], '#launch', d)).toBe(false)
    expect(d.success).not.toHaveBeenCalled()
  })

  it('a failed Undo says so', async () => {
    const d = deps()
    d.fetch = async () => new Response('{}', { status: 500 })
    expect(await undoShare(['g-1'], d)).toBe(false)
    toastSharedRecords([{ grant_id: 'g-1', type: 'capture', id: 'c', label: 'Call' }], null, d)
    d.success.mock.calls[0][1].action.onClick()
    await vi.waitFor(() => expect(d.error).toHaveBeenCalledWith("Couldn't take the share back"))
  })

  it('keeps only well-formed shares from an answer', () => {
    expect(
      parseSharedRecords({
        shared: [
          { grant_id: 'g-1', type: 'document', id: 'd', label: 'Doc' },
          { grant_id: 'g-2', type: 'action', id: 'a', label: 'Task' },
          { type: 'document', id: 'd2', label: 'No grant id' },
          'junk',
        ],
        shared_with: '#launch',
      }),
    ).toEqual({ shared: [{ grant_id: 'g-1', type: 'document', id: 'd', label: 'Doc' }], sharedWith: '#launch' })
    expect(parseSharedRecords(null)).toEqual({ shared: [], sharedWith: null })
  })

  it('words', () => {
    expect(sharedToastText([{ label: 'A' }, { label: 'B' }], '#ops')).toBe('Shared 2 records with #ops')
    expect(sharedToastText([{ label: 'A' }], null)).toBe('Shared “A” with this conversation')
    expect(channelAudience({ kind: 'channel', name: 'ops' })).toBe('#ops')
    expect(channelAudience({ kind: 'dm', name: null }, 'Maya Chen')).toBe('Maya Chen')
  })
})
