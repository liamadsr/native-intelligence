/**
 * Migration 341's rule, the app's copy: a claim is readable only when one of
 * its sources is. Any mail source hides it from everyone; a capture source is
 * readable when the capture is not an eval and is workspace-visible or the
 * reader's own; an attachment follows its parent capture; anything else is
 * readable; a claim with no sources is readable. A chat (a `conversation`
 * source) is readable only by the person whose conversation it is (353, Liam
 * 2026-10-17). These are the filters the service-role paths (the agent's
 * tools) and the knowledge graph use.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  captureVisibleTo,
  claimIdsHiddenFrom,
  claimIdsHiddenInWorkspace,
  conversationIdsHiddenFrom,
  conversationVisibleTo,
  documentVisibleTo,
  excludeClaimsHiddenFrom,
  hiddenClaimIds,
} from '../claim-visibility'

const ME = 'me'
const WS = 'ws-1'

type Row = Record<string, unknown>

/** In-memory tables honouring eq, in, a simple `col.eq.val,...` or, range and limit. */
function makeDb(tables: Record<string, Row[]>, errorOn?: string) {
  const reads: string[] = []
  const from = vi.fn((table: string) => {
    reads.push(table)
    const preds: Array<(r: Row) => boolean> = []
    let range: [number, number] | null = null
    let limitN = Infinity
    const run = () => {
      if (table === errorOn) return { data: null, error: { message: 'boom' } }
      let out = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)))
      if (range) out = out.slice(range[0], range[1] + 1)
      return { data: out.slice(0, limitN), error: null }
    }
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (k: string, v: unknown) => (preds.push((r) => r[k] === v), api),
      in: (k: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[k])), api),
      or: (f: string) => {
        const clauses = f.split(',').map((c) => c.split('.'))
        preds.push((r) => clauses.some(([col, op, val]) => op === 'is' ? r[col] == null : String(r[col]) === val))
        return api
      },
      order: () => api,
      range: (a: number, b: number) => ((range = [a, b]), api),
      limit: (n: number) => ((limitN = n), api),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    }
    return api
  })
  return { client: { from } as never, reads }
}

const captures = [
  { id: 'shared', workspace_id: WS, visibility: 'workspace', user_id: 'them', is_eval: false },
  { id: 'theirs', workspace_id: WS, visibility: 'private', user_id: 'them', is_eval: false },
  { id: 'mine', workspace_id: WS, visibility: 'private', user_id: ME, is_eval: false },
  { id: 'eval', workspace_id: WS, visibility: 'workspace', user_id: ME, is_eval: true },
]
const attachments = [
  { id: 'att-theirs', workspace_id: WS, note_id: 'theirs' },
  { id: 'att-loose', workspace_id: WS, note_id: null },
]
// The cited documents (369): doc-1 is a workspace document.
const documents = [{ id: 'doc-1', workspace_id: WS, visibility: 'workspace', owner: { user_id: 'them' } }]
const src = (claim_id: string, source_type: string, source_id: string | null) => ({ id: `${claim_id}:${source_type}:${source_id}`, claim_id, workspace_id: WS, source_type, source_id })
const claimSources = [
  src('shared-meeting', 'capture', 'shared'),
  src('their-private', 'capture', 'theirs'),
  src('my-private', 'capture', 'mine'),
  src('eval-only', 'capture', 'eval'),
  src('private-plus-doc', 'capture', 'theirs'),
  src('private-plus-doc', 'document', 'doc-1'),
  src('mail', 'email', 'msg-1'),
  src('mail-plus-shared', 'email', 'msg-2'),
  src('mail-plus-shared', 'capture', 'shared'),
  src('their-attachment', 'attachment', 'att-theirs'),
  src('loose-attachment', 'attachment', 'att-loose'),
  src('dangling', 'capture', 'deleted-capture'),
]
const ALL = ['shared-meeting', 'their-private', 'my-private', 'eval-only', 'private-plus-doc', 'mail', 'mail-plus-shared', 'their-attachment', 'loose-attachment', 'dangling', 'no-sources']

describe('captureVisibleTo', () => {
  it('follows claim_visible_to: never an eval; private only for its owner', () => {
    expect(captureVisibleTo(captures[0], ME)).toBe(true)
    expect(captureVisibleTo(captures[1], ME)).toBe(false)
    expect(captureVisibleTo(captures[2], ME)).toBe(true)
    expect(captureVisibleTo(captures[2], null)).toBe(false)
    expect(captureVisibleTo(captures[3], ME)).toBe(false)
    expect(captureVisibleTo(undefined, ME)).toBe(false)
  })
})

describe('hiddenClaimIds (pure)', () => {
  it('hides mail, other people\'s private and eval captures, and dangling refs; keeps any claim with one readable source', () => {
    const caps = new Map(captures.map((c) => [c.id, c]))
    const atts = new Map(attachments.map((a) => [a.id, a.note_id]))
    const hidden = hiddenClaimIds(ALL, claimSources, caps, atts, ME)
    expect([...hidden].sort()).toEqual(['dangling', 'eval-only', 'mail', 'mail-plus-shared', 'their-attachment', 'their-private'])
    // No requester: my own private capture no longer counts.
    expect(hiddenClaimIds(ALL, claimSources, caps, atts, null).has('my-private')).toBe(true)
  })
})

describe('claimIdsHiddenFrom', () => {
  const tables = { claim_source: claimSources, captures, attachments, document: documents }

  it('reads the claims\' sources, then the cited attachments, captures and documents: four reads', async () => {
    const { client, reads } = makeDb(tables)
    const hidden = await claimIdsHiddenFrom(client, ALL, ME)
    expect([...(hidden ?? [])].sort()).toEqual(['dangling', 'eval-only', 'mail', 'mail-plus-shared', 'their-attachment', 'their-private'])
    expect(reads).toEqual(['claim_source', 'attachments', 'captures', 'document'])
  })

  it('fails closed on any failed read', async () => {
    for (const table of ['claim_source', 'attachments', 'captures', 'document']) {
      const { client } = makeDb(tables, table)
      expect(await claimIdsHiddenFrom(client, ALL, ME), table).toBeNull()
    }
    const { client } = makeDb(tables, 'captures')
    expect(await excludeClaimsHiddenFrom(client, [{ id: 'shared-meeting' }], ME)).toEqual([])
  })

  it('treats a chunk whose sources reached the row cap as hidden (it may be truncated)', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => src('busy', 'document', `d${i}`))
    const { client } = makeDb({ claim_source: many, captures, attachments })
    expect([...((await claimIdsHiddenFrom(client, ['busy', 'other'], ME)) ?? [])].sort()).toEqual(['busy', 'other'])
  })
})

describe('claimIdsHiddenInWorkspace (the knowledge graph)', () => {
  it('starts from the hidden things and rechecks candidates exactly', async () => {
    const { client } = makeDb({ claim_source: claimSources, captures, attachments, document: documents })
    const hidden = await claimIdsHiddenInWorkspace(client, WS, ME)
    // Same as the exact rule, minus the dangling reference, which only a scan
    // of every source would find (the RLS set has the same gap; see 341).
    expect([...(hidden ?? [])].sort()).toEqual(['eval-only', 'mail', 'mail-plus-shared', 'their-attachment', 'their-private'])
  })

  it('reads no source rows beyond the mail ones when nothing is hidden', async () => {
    const { client, reads } = makeDb({ claim_source: [src('a', 'capture', 'shared')], captures: [captures[0]], attachments: [] })
    expect([...((await claimIdsHiddenInWorkspace(client, WS, ME)) ?? ['x'])]).toEqual([])
    // The mail sources, the hidden captures, the chat sources, the private documents: nothing more.
    expect(reads).toEqual(['claim_source', 'captures', 'claim_source', 'document'])
  })

  it('fails closed on any failed read', async () => {
    for (const table of ['claim_source', 'captures', 'attachments']) {
      const { client } = makeDb({ claim_source: claimSources, captures, attachments }, table)
      expect(await claimIdsHiddenInWorkspace(client, WS, ME), table).toBeNull()
    }
  })
})

describe('chats are their owner\'s (353)', () => {
  const conversations = [
    { id: 'conv-mine', workspace_id: WS, user_id: ME },
    { id: 'conv-theirs', workspace_id: WS, user_id: 'them' },
  ]
  const chatSources = [
    src('my-chat', 'conversation', 'conv-mine'),
    src('their-chat', 'conversation', 'conv-theirs'),
    src('their-chat-plus-meeting', 'conversation', 'conv-theirs'),
    src('their-chat-plus-meeting', 'capture', 'shared'),
    src('deleted-chat', 'conversation', 'conv-gone'),
  ]
  const CHATS = ['my-chat', 'their-chat', 'their-chat-plus-meeting', 'deleted-chat']
  const tables = { claim_source: chatSources, captures, attachments, chat_conversations: conversations }

  it('conversationVisibleTo: the requester\'s own conversation only, never for no requester', () => {
    expect(conversationVisibleTo(ME, ME)).toBe(true)
    expect(conversationVisibleTo('them', ME)).toBe(false)
    expect(conversationVisibleTo(ME, null)).toBe(false)
    expect(conversationVisibleTo(undefined, ME)).toBe(false)
  })

  it('hiddenClaimIds: someone else\'s chat hides a claim known only from it; a meeting keeps it shared', () => {
    const owners = new Map(conversations.map((c) => [c.id, c.user_id] as const))
    const caps = new Map(captures.map((c) => [c.id, c]))
    expect([...hiddenClaimIds(CHATS, chatSources, caps, new Map(), ME, owners)].sort()).toEqual(['deleted-chat', 'their-chat'])
    // The owner of the other chat sees theirs, not mine.
    expect([...hiddenClaimIds(CHATS, chatSources, caps, new Map(), 'them', owners)].sort()).toEqual(['deleted-chat', 'my-chat'])
    // No requester (the weaver, briefs): no chat counts at all.
    expect([...hiddenClaimIds(CHATS, chatSources, caps, new Map(), null, owners)].sort()).toEqual(['deleted-chat', 'my-chat', 'their-chat'])
    // Owners not passed: every chat counts as hidden (fail closed).
    expect(hiddenClaimIds(['my-chat'], chatSources, caps, new Map(), ME).has('my-chat')).toBe(true)
  })

  it('claimIdsHiddenFrom reads the cited conversations\' owners, and fails closed when it can\'t', async () => {
    const { client, reads } = makeDb(tables)
    expect([...((await claimIdsHiddenFrom(client, CHATS, ME)) ?? [])].sort()).toEqual(['deleted-chat', 'their-chat'])
    expect(reads).toContain('chat_conversations')
    const failing = makeDb(tables, 'chat_conversations')
    expect(await claimIdsHiddenFrom(failing.client, CHATS, ME)).toBeNull()
    // For no requester there is nothing to read: every chat is hidden.
    const unattended = makeDb(tables)
    expect([...((await claimIdsHiddenFrom(unattended.client, CHATS, null)) ?? [])].sort()).toEqual(['deleted-chat', 'my-chat', 'their-chat'])
    expect(unattended.reads).not.toContain('chat_conversations')
  })

  it('claimIdsHiddenInWorkspace (the knowledge graph) hides other people\'s chat claims, keeps mine and the shared one', async () => {
    const { client } = makeDb(tables)
    expect([...((await claimIdsHiddenInWorkspace(client, WS, ME)) ?? [])].sort()).toEqual(['deleted-chat', 'their-chat'])
    const failing = makeDb(tables, 'chat_conversations')
    expect(await claimIdsHiddenInWorkspace(failing.client, WS, ME)).toBeNull()
  })

  it('conversationIdsHiddenFrom: other people\'s and unknown conversations; all of them for no requester', async () => {
    const { client } = makeDb(tables)
    expect([...((await conversationIdsHiddenFrom(client, ['conv-mine', 'conv-theirs', 'conv-gone'], ME)) ?? [])].sort()).toEqual(['conv-gone', 'conv-theirs'])
    expect([...((await conversationIdsHiddenFrom(client, ['conv-mine'], null)) ?? [])]).toEqual(['conv-mine'])
    expect(await conversationIdsHiddenFrom(makeDb(tables, 'chat_conversations').client, ['conv-mine'], ME)).toBeNull()
  })
})

describe('private documents are their creator\'s (369)', () => {
  const docs = [
    { id: 'doc-shared', workspace_id: WS, visibility: 'workspace', owner: { user_id: 'them' } },
    { id: 'doc-mine', workspace_id: WS, visibility: 'private', owner: { user_id: ME } },
    { id: 'doc-theirs', workspace_id: WS, visibility: 'private', owner: { user_id: 'them' } },
  ]
  const docSources = [
    src('from-shared-doc', 'document', 'doc-shared'),
    src('from-my-doc', 'document', 'doc-mine'),
    src('from-their-doc', 'document', 'doc-theirs'),
    src('their-doc-plus-meeting', 'document', 'doc-theirs'),
    src('their-doc-plus-meeting', 'capture', 'shared'),
    src('from-deleted-doc', 'document', 'doc-gone'),
  ]
  const DOCS = ['from-shared-doc', 'from-my-doc', 'from-their-doc', 'their-doc-plus-meeting', 'from-deleted-doc']
  const tables = { claim_source: docSources, captures, attachments, document: docs }

  it('documentVisibleTo: a workspace document, or the requester\'s own private one', () => {
    expect(documentVisibleTo({ visibility: 'workspace', owner_user_id: 'them' }, null)).toBe(true)
    expect(documentVisibleTo({ visibility: 'private', owner_user_id: ME }, ME)).toBe(true)
    expect(documentVisibleTo({ visibility: 'private', owner_user_id: ME }, null)).toBe(false)
    expect(documentVisibleTo({ visibility: 'private', owner_user_id: 'them' }, ME)).toBe(false)
    expect(documentVisibleTo(undefined, ME)).toBe(false)
  })

  it('claimIdsHiddenFrom: someone else\'s private document hides a claim known only from it', async () => {
    const { client } = makeDb(tables)
    expect([...((await claimIdsHiddenFrom(client, DOCS, ME)) ?? [])].sort()).toEqual(['from-deleted-doc', 'from-their-doc'])
    expect([...((await claimIdsHiddenFrom(client, DOCS, null)) ?? [])].sort()).toEqual(['from-deleted-doc', 'from-my-doc', 'from-their-doc'])
  })

  it('claimIdsHiddenInWorkspace finds them from the private documents', async () => {
    const { client } = makeDb(tables)
    expect([...((await claimIdsHiddenInWorkspace(client, WS, ME)) ?? [])].sort()).toEqual(['from-their-doc'])
  })
})
