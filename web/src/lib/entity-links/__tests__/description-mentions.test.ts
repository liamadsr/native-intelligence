/**
 * A record's description/notes `@` chips become `mentions` edges from that
 * record, and a teammate newly mentioned is told once
 * (../description-mentions.ts). An edit takes back only what its own previous
 * text named and the new text doesn't. Fixtures are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { mentionMarkdown } from '@/lib/documents/mention-markdown'

// Contacts are visible (the RPC fence is exercised elsewhere); here we care
// about the edges and the one notification.
vi.mock('@/lib/crm/contact-visibility', () => ({
  filterVisibleContacts: async (_s: unknown, _u: unknown, rows: Array<{ id: string }>) => rows,
  filterVisibleCompanies: async (_s: unknown, _u: unknown, rows: Array<{ id: string }>) => rows,
}))
const hoisted = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock('@/lib/notifications', () => ({ createNotification: (n: unknown) => hoisted.notify(n) }))

const { syncDescriptionMentions } = await import('../description-mentions')

const WS = '11111111-1111-4111-8111-111111111111'
const ANA_USER = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const ANA = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const SAM = '33333333-3333-4333-8333-bbbbbbbbbbbb'
const ACTION = 'a0000000-0000-4000-8000-000000000042'
const DEAL = 'e0000000-0000-4000-8000-000000000001'
const SAM_CONTACT = 'c0000000-0000-4000-8000-00000000005a'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

beforeEach(() => {
  hoisted.notify.mockReset()
  tables = {
    member: [
      { id: ANA, user_id: ANA_USER, workspace_id: WS, display_name: 'Ana Ruiz' },
      { id: SAM, user_id: '22222222-2222-4222-8222-cccccccccccc', workspace_id: WS, display_name: 'Sam Ortiz' },
    ],
    contact: [{ id: SAM_CONTACT, workspace_id: WS, member_id: SAM, full_name: 'Sam Ortiz' }],
    actions: [{ id: ACTION, workspace_id: WS, identifier: 'GEN-42', title: 'Ship the thing' }],
    flow: [{ id: DEAL, workspace_id: WS, name: 'Harbor renewal' }],
    entity_link: [],
  }
})

const edges = () =>
  tables.entity_link
    .filter((e) => e.source_id === ACTION && e.relation === 'mentions')
    .map((e) => `${e.target_type}:${e.target_id}`)
    .sort()

describe('syncDescriptionMentions', () => {
  it('adds a mention edge for each chip the description names', async () => {
    const db = memoryDb(tables)
    const body = `Owner ${mentionMarkdown({ type: 'contact', id: SAM_CONTACT, label: 'Sam Ortiz' })} on ${mentionMarkdown({ type: 'flow', id: DEAL, label: 'Harbor renewal' })}`
    await syncDescriptionMentions(db, { workspaceId: WS, source: { type: 'action', id: ACTION }, markdown: body, previousMarkdown: '', userId: ANA_USER, memberId: ANA, title: 'Ship the thing' })
    expect(edges()).toEqual([`contact:${SAM_CONTACT}`, `flow:${DEAL}`].sort())
  })

  it('tells a teammate newly mentioned, once, naming the record', async () => {
    const db = memoryDb(tables)
    const body = `cc ${mentionMarkdown({ type: 'contact', id: SAM_CONTACT, label: 'Sam Ortiz' })}`
    await syncDescriptionMentions(db, { workspaceId: WS, source: { type: 'action', id: ACTION }, markdown: body, previousMarkdown: '', userId: ANA_USER, memberId: ANA, title: 'Ship the thing' })
    expect(hoisted.notify.mock.calls.map((c) => c[0])).toEqual([
      { workspaceId: WS, recipientId: SAM, type: 'mentioned', title: 'Ana Ruiz mentioned you in Ship the thing', actorId: ANA, targetType: 'action', targetId: ACTION },
    ])
  })

  it('does not tell the same teammate again when the mention was already there', async () => {
    const db = memoryDb(tables)
    const body = `cc ${mentionMarkdown({ type: 'contact', id: SAM_CONTACT, label: 'Sam Ortiz' })}`
    await syncDescriptionMentions(db, { workspaceId: WS, source: { type: 'action', id: ACTION }, markdown: body, previousMarkdown: '', userId: ANA_USER, memberId: ANA })
    hoisted.notify.mockReset()
    // An unrelated edit that keeps the same chip: no new edge, no new notification.
    await syncDescriptionMentions(db, { workspaceId: WS, source: { type: 'action', id: ACTION }, markdown: `done — ${body}`, previousMarkdown: body, userId: ANA_USER, memberId: ANA })
    expect(hoisted.notify).not.toHaveBeenCalled()
  })

  it('an edit takes back the edge of a chip its new text no longer names', async () => {
    const db = memoryDb(tables)
    const before = `on ${mentionMarkdown({ type: 'flow', id: DEAL, label: 'Harbor renewal' })}`
    await syncDescriptionMentions(db, { workspaceId: WS, source: { type: 'action', id: ACTION }, markdown: before, previousMarkdown: '', userId: ANA_USER, memberId: ANA })
    expect(edges()).toEqual([`flow:${DEAL}`])
    await syncDescriptionMentions(db, { workspaceId: WS, source: { type: 'action', id: ACTION }, markdown: 'nothing now', previousMarkdown: before, userId: ANA_USER, memberId: ANA })
    expect(edges()).toEqual([])
  })

  it('a capture’s notes: a private capture records the mention but tells no teammate; a shared one tells them', async () => {
    const CAPTURE = 'f0000000-0000-4000-8000-000000000007'
    tables.captures = [{ id: CAPTURE, workspace_id: WS, user_id: ANA_USER, title: 'Weekly sync', visibility: 'private' }]
    const db = memoryDb(tables)
    const body = `Follow up with ${mentionMarkdown({ type: 'contact', id: SAM_CONTACT, label: 'Sam Ortiz' })}`
    const captureEdges = () => tables.entity_link.filter((e) => e.source_id === CAPTURE && e.relation === 'mentions').map((e) => `${e.target_type}:${e.target_id}`)

    // Private: only its creator can open it, so the mention is recorded and no one is told.
    await syncDescriptionMentions(db, { workspaceId: WS, source: { type: 'capture', id: CAPTURE }, markdown: body, previousMarkdown: '', userId: ANA_USER, memberId: ANA, title: 'Weekly sync', gate: { visibility: 'private', createdBy: null } })
    expect(captureEdges()).toEqual([`contact:${SAM_CONTACT}`])
    expect(hoisted.notify).not.toHaveBeenCalled()

    // Shared with the workspace (no gate): a teammate newly mentioned is told, naming the capture.
    tables.entity_link = []
    await syncDescriptionMentions(memoryDb(tables), { workspaceId: WS, source: { type: 'capture', id: CAPTURE }, markdown: body, previousMarkdown: '', userId: ANA_USER, memberId: ANA, title: 'Weekly sync' })
    expect(hoisted.notify.mock.calls.map((c) => c[0])).toEqual([
      { workspaceId: WS, recipientId: SAM, type: 'mentioned', title: 'Ana Ruiz mentioned you in Weekly sync', actorId: ANA, targetType: 'capture', targetId: CAPTURE },
    ])
  })
})
