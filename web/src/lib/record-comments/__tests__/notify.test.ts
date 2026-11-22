/**
 * Who hears about a comment on a canvas or a spreadsheet: the teammates it
 * mentions and, on a reply, the thread's author, and only those of them who
 * can open the record. Made-up people.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

const sent = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn(async (n: Record<string, unknown>) => void sent.list.push(n)) }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('no service client in tests') } }))

const { memberCanOpenRecord, sendRecordCommentNotifications } = await import('../notify')

const WS = 'ws-1'
const CANVAS = 'canvas-1'
const SHEET = 'sheet-1'
const [ADA, BEN, CAL, DEE] = ['m-ada', 'm-ben', 'm-cal', 'm-dee']

/** Who the database says can open which record (by user id). */
let canOpen: Record<string, string[]>
let rpcFails = false
function service(): SupabaseClient {
  const db = memoryDb({
    member: [
      { id: ADA, workspace_id: WS, user_id: 'u-ada', display_name: 'Ada Example' },
      { id: BEN, workspace_id: WS, user_id: 'u-ben', display_name: 'Ben Example' },
      { id: CAL, workspace_id: WS, user_id: 'u-cal', display_name: 'Cal Example' },
      { id: DEE, workspace_id: WS, user_id: null, display_name: 'Dee Example' },
      { id: 'm-out', workspace_id: 'ws-2', user_id: 'u-out', display_name: 'Outsider' },
    ],
    canvas: [{ id: CANVAS, workspace_id: WS, title: 'Launch plan' }],
    spreadsheet: [{ id: SHEET, workspace_id: WS, title: 'Q1 budget' }],
    canvas_comment: [{ id: 'thread-1', canvas_id: CANVAS, author_id: BEN }],
    spreadsheet_comment: [{ id: 'thread-2', spreadsheet_id: SHEET, author_id: CAL }],
  })
  return Object.assign(db, {
    rpc: async (fn: string, args: Record<string, string>) => {
      if (rpcFails) return { data: null, error: { message: 'down' } }
      const [id, user] = fn === 'canvas_visible_to' ? [args.p_canvas_id, args.p_user_id] : [args.p_id, args.p_user]
      return { data: (canOpen[id] ?? []).includes(user), error: null }
    },
  }) as unknown as SupabaseClient
}

const base = { kind: 'canvas' as const, recordId: CANVAS, workspaceId: WS, authorMemberId: ADA, commentId: 'c-9', body: 'Can you check the dates, @Ben Example?' }
const told = () => sent.list.map((n) => [n.recipientId, n.type])

beforeEach(() => {
  sent.list = []
  rpcFails = false
  canOpen = { [CANVAS]: ['u-ada', 'u-ben', 'u-cal'], [SHEET]: ['u-ada', 'u-cal'] }
})

describe('a comment on a canvas', () => {
  it('tells each teammate it mentions, pointing at the canvas', async () => {
    const n = await sendRecordCommentNotifications({ ...base, mentionedMemberIds: [BEN, CAL] }, { service: service() })
    expect(n).toBe(2)
    expect(told()).toEqual([[BEN, 'mentioned'], [CAL, 'mentioned']])
    expect(sent.list[0]).toMatchObject({ workspaceId: WS, actorId: ADA, targetType: 'canvas', targetId: CANVAS, title: 'Ada Example mentioned you on Launch plan', metadata: { comment_id: 'c-9' } })
  })

  it('tells nobody who cannot open it: a private canvas keeps its title and its words', async () => {
    canOpen[CANVAS] = ['u-ada']
    const n = await sendRecordCommentNotifications({ ...base, mentionedMemberIds: [BEN, CAL], parentId: 'thread-1' }, { service: service() })
    expect(n).toBe(0)
    expect(sent.list).toEqual([])
  })

  it('reads anything unsure as no: a failed check, a member with no user, one from another workspace', async () => {
    rpcFails = true
    await sendRecordCommentNotifications({ ...base, mentionedMemberIds: [BEN] }, { service: service() })
    rpcFails = false
    await sendRecordCommentNotifications({ ...base, mentionedMemberIds: [DEE, 'm-out', 'm-nobody'] }, { service: service() })
    expect(sent.list).toEqual([])
    expect(await memberCanOpenRecord(service(), 'canvas', CANVAS, WS, 'm-out')).toBe(false)
    expect(await memberCanOpenRecord(service(), 'canvas', CANVAS, WS, BEN)).toBe(true)
  })

  it('tells the thread\'s author of a reply, once, and as mentioned when the reply also names them', async () => {
    await sendRecordCommentNotifications({ ...base, parentId: 'thread-1' }, { service: service() })
    expect(told()).toEqual([[BEN, 'comment_reply']])
    expect(sent.list[0]).toMatchObject({ title: 'Ada Example replied to your comment on Launch plan', metadata: { parent_comment_id: 'thread-1' } })
    sent.list = []
    await sendRecordCommentNotifications({ ...base, parentId: 'thread-1', mentionedMemberIds: [BEN] }, { service: service() })
    expect(told()).toEqual([[BEN, 'mentioned']])
  })

  it('never tells the author, and ignores a parent that is not on this canvas', async () => {
    await sendRecordCommentNotifications({ ...base, authorMemberId: BEN, parentId: 'thread-1', mentionedMemberIds: [BEN] }, { service: service() })
    await sendRecordCommentNotifications({ ...base, parentId: 'thread-2' }, { service: service() })
    expect(sent.list).toEqual([])
  })

  it('says the assistant wrote it when it did', async () => {
    await sendRecordCommentNotifications({ ...base, mentionedMemberIds: [BEN], viaAgent: true }, { service: service() })
    expect(sent.list[0]).toMatchObject({ title: "Ada Example's assistant mentioned you on Launch plan", actorId: ADA, metadata: { via_agent: true } })
  })

  it('sends nothing for a canvas that is gone or in another workspace, and never throws', async () => {
    expect(await sendRecordCommentNotifications({ ...base, recordId: 'gone', mentionedMemberIds: [BEN] }, { service: service() })).toBe(0)
    expect(await sendRecordCommentNotifications({ ...base, workspaceId: 'ws-2', mentionedMemberIds: [BEN] }, { service: service() })).toBe(0)
    expect(await sendRecordCommentNotifications({ ...base, mentionedMemberIds: [BEN] })).toBe(0)
    expect(sent.list).toEqual([])
  })
})

describe('a comment on a spreadsheet', () => {
  it('asks the spreadsheet\'s own rule, and points at the spreadsheet', async () => {
    const n = await sendRecordCommentNotifications({ kind: 'spreadsheet', recordId: SHEET, workspaceId: WS, authorMemberId: ADA, commentId: 'c-2', body: 'Totals look off', parentId: 'thread-2', mentionedMemberIds: [BEN] }, { service: service() })
    // Ben cannot open this one; Cal started the thread and can.
    expect(n).toBe(1)
    expect(told()).toEqual([[CAL, 'comment_reply']])
    expect(sent.list[0]).toMatchObject({ targetType: 'spreadsheet', targetId: SHEET, title: 'Ada Example replied to your comment on Q1 budget' })
  })
})
