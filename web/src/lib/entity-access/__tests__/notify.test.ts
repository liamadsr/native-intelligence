/**
 * The notice to the person a spreadsheet or canvas was shared with
 * (record_shared, migration 688; docs/plans/record-sharing.md, Phase 2).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn() }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))

import { notifyRecordShared, readGrantForNotice, shareNoticeText } from '../notify'

const WS = 'ws-1'
const SHEET = '33333333-3333-4333-8333-000000000002'
const BOARD = '44444444-4444-4444-8444-000000000002'

const tables = () => ({
  member: [
    { id: 'm-ana', workspace_id: WS, display_name: 'Ana Reyes' },
    { id: 'm-ben', workspace_id: WS, display_name: 'Ben Ortiz' },
  ],
  spreadsheet: [{ id: SHEET, workspace_id: WS, title: 'Q3 plan' }],
  canvas: [{ id: BOARD, workspace_id: WS, title: '' }],
  entity_access: [
    { id: 'g-1', workspace_id: WS, entity_type: 'canvas', entity_id: BOARD, grantee_kind: 'member', grantee_member_id: 'm-ben', grantee_team_id: null, grantee_channel_id: null, level: 'view' },
  ],
})

const share = (over: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  actorMemberId: 'm-ana',
  type: 'spreadsheet' as const,
  id: SHEET,
  granteeKind: 'member' as const,
  granteeId: 'm-ben',
  level: 'view' as const,
  ...over,
})

beforeEach(() => hoisted.createNotification.mockReset().mockResolvedValue(undefined))

describe('the share notice', () => {
  it('names who shared what, and the level', () => {
    expect(shareNoticeText({ actor: 'Ana', title: 'Q3 plan', type: 'spreadsheet', level: 'view' })).toEqual({ title: 'Ana shared “Q3 plan” with you', body: 'Can view' })
    expect(shareNoticeText({ actor: 'Ana', title: 'Q3 plan', type: 'spreadsheet', level: 'edit' }).body).toBe('Can edit')
    expect(shareNoticeText({ actor: 'Ana', title: '  ', type: 'canvas', level: 'view' }).title).toBe('Ana shared a canvas with you')
    expect(shareNoticeText({ actor: 'Ana', title: 'Q3 plan', type: 'spreadsheet', level: 'edit', raised: true })).toEqual({ title: 'Ana gave you edit access to “Q3 plan”', body: 'Can edit' })
    expect(shareNoticeText({ actor: 'Ana', title: 'x'.repeat(200), type: 'canvas', level: 'view' }).title.length).toBeLessThan(110)
  })

  it('goes to the member, targeting the record, with the sharer as its actor', async () => {
    await notifyRecordShared(memoryDb(tables()), share({ level: 'edit' }))
    expect(hoisted.createNotification).toHaveBeenCalledWith({
      workspaceId: WS,
      recipientId: 'm-ben',
      actorId: 'm-ana',
      type: 'record_shared',
      title: 'Ana Reyes shared “Q3 plan” with you',
      body: 'Can edit',
      targetType: 'spreadsheet',
      targetId: SHEET,
      metadata: { level: 'edit' },
    })
  })

  it('says nothing for a team or channel grant, to the sharer, or for the kinds that share quietly', async () => {
    const db = memoryDb(tables())
    await notifyRecordShared(db, share({ granteeKind: 'team', granteeId: 'team-1' }))
    await notifyRecordShared(db, share({ granteeKind: 'channel', granteeId: 'ch-1' }))
    await notifyRecordShared(db, share({ granteeId: 'm-ana' }))
    for (const type of ['document', 'capture', 'contact', 'company', 'data_table'] as const) await notifyRecordShared(db, share({ type }))
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  it('never throws when its reads fail (createNotification swallows its own failures)', async () => {
    await expect(notifyRecordShared({} as never, share())).resolves.toBeUndefined()
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  it('reads a grant for a later raise, and null for one that is not there or on a broken client', async () => {
    expect(await readGrantForNotice(memoryDb(tables()), WS, 'g-1')).toEqual({ type: 'canvas', id: BOARD, granteeKind: 'member', granteeId: 'm-ben', level: 'view' })
    expect(await readGrantForNotice(memoryDb(tables()), WS, 'g-none')).toBeNull()
    expect(await readGrantForNotice({} as never, WS, 'g-1')).toBeNull()
  })
})
