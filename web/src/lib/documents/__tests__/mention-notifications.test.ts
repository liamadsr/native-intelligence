/**
 * A teammate @-mentioned in a document is told once (../mention-notifications.ts):
 * only contacts linked to a member, never the author, and on a private
 * document only its creator. Fixtures are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'

const hoisted = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock('@/lib/notifications', () => ({ createNotification: (n: unknown) => hoisted.notify(n) }))

const { notifyDocumentMentions } = await import('../mention-notifications')

const WS = 'ws-1'
type Row = Record<string, unknown>
let tables: Record<string, Row[]>

beforeEach(() => {
  hoisted.notify.mockReset()
  tables = {
    member: [
      { id: 'm-ana', workspace_id: WS, display_name: 'Ana Ruiz' },
      { id: 'm-sam', workspace_id: WS, display_name: 'Sam Ortiz' },
    ],
    contact: [
      { id: 'c-sam', workspace_id: WS, member_id: 'm-sam' },
      { id: 'c-ana', workspace_id: WS, member_id: 'm-ana' },
      { id: 'c-client', workspace_id: WS, member_id: null },
      { id: 'c-far', workspace_id: 'another', member_id: 'm-far' },
    ],
    document: [{ id: 'doc-1', workspace_id: WS, title: 'Harbor plan', visibility: 'workspace', created_by: 'm-ana' }],
  }
})

const run = () => notifyDocumentMentions(memoryDb(tables), { workspaceId: WS, documentId: 'doc-1', authorMemberId: 'm-ana', contactIds: ['c-sam', 'c-ana', 'c-client', 'c-far'] })

describe('notifyDocumentMentions', () => {
  it('tells the teammates mentioned, not the author, a client or another workspace’s contact', async () => {
    await run()
    expect(hoisted.notify.mock.calls.map((c) => c[0])).toEqual([
      { workspaceId: WS, recipientId: 'm-sam', type: 'mentioned', title: 'Ana Ruiz mentioned you in Harbor plan', actorId: 'm-ana', targetType: 'document', targetId: 'doc-1' },
    ])
  })

  it('tells no teammate about a private document they cannot open', async () => {
    tables.document[0].visibility = 'private'
    await run()
    expect(hoisted.notify).not.toHaveBeenCalled()
  })

  it('does nothing when the document is gone', async () => {
    tables.document = []
    await run()
    expect(hoisted.notify).not.toHaveBeenCalled()
  })
})
