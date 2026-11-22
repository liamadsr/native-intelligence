import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const calls = vi.hoisted(() => ({ notify: [] as Array<Record<string, unknown>>, apply: [] as Array<Record<string, unknown>> }))
vi.mock('../notify', () => ({ sendRecordCommentNotifications: vi.fn(async (n: Record<string, unknown>) => (calls.notify.push(n), 0)) }))
vi.mock('@/lib/comment-mentions', () => ({
  NO_COMMENT_MENTIONS: { memberIds: [], records: [] },
  fenceCommentMentions: vi.fn(async () => ({ memberIds: [], records: [] })),
  applyCommentMentions: vi.fn(async (_s: unknown, input: Record<string, unknown>) => void calls.apply.push(input)),
}))

const { afterRecordComment } = await import('../mentions')
const db = {} as SupabaseClient
const saved = { kind: 'canvas' as const, recordId: 'cv', workspaceId: 'ws', userId: 'u', memberId: 'm-me', commentId: 'c1', body: 'Hi @Ben', mentions: { memberIds: ['m-ben', 'm-cal'], records: [{ type: 'document' as const, id: 'd1', label: 'Spec' }] } }

beforeEach(() => {
  calls.notify = []
  calls.apply = []
})

describe('after a comment on a canvas or spreadsheet is saved', () => {
  it('links the records it names from that record, and tells who it names and the thread', async () => {
    await afterRecordComment(db, { ...saved, parentId: 'thread-1' })
    expect(calls.apply[0]).toMatchObject({ workspaceId: 'ws', userId: 'u', memberId: 'm-me', commentable: { type: 'canvas', id: 'cv' }, mentions: saved.mentions })
    expect(calls.notify[0]).toMatchObject({ kind: 'canvas', recordId: 'cv', authorMemberId: 'm-me', commentId: 'c1', parentId: 'thread-1', mentionedMemberIds: ['m-ben', 'm-cal'] })
  })

  it('after an edit, tells only who is newly named, and nobody of a reply again', async () => {
    await afterRecordComment(db, { ...saved, kind: 'spreadsheet', parentId: 'thread-1', alreadyMentioned: ['m-ben'] })
    expect(calls.notify[0]).toMatchObject({ kind: 'spreadsheet', parentId: null, mentionedMemberIds: ['m-cal'] })
  })

  it('carries the assistant\'s mark to the notice', async () => {
    await afterRecordComment(db, { ...saved, viaAgent: true })
    expect(calls.notify[0]).toMatchObject({ viaAgent: true })
  })
})
