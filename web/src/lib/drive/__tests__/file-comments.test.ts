import { describe, expect, it } from 'vitest'
import { noticeRecord, parseFileTarget, readNewComment, targetColumns, threadsOfFile, type FileComment } from '../file-comments'
import { pinNumbers } from '@/components/files/file-comments'

const ATT = '11111111-1111-4111-8111-111111111111'
const MSG = '22222222-2222-4222-8222-222222222222'
const PATH = '33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444/a.pdf'

describe('a file comment’s file', () => {
  it('is an upload or a chat file, never anything else', () => {
    expect(parseFileTarget({ attachment: ATT })).toEqual({ kind: 'attachment', id: ATT })
    expect(parseFileTarget({ message: MSG, path: PATH })).toEqual({ kind: 'chat', messageId: MSG, path: PATH })
    expect(parseFileTarget({ message: MSG, path: '../etc/passwd' })).toBeNull()
    expect(parseFileTarget({ message: MSG })).toBeNull()
    expect(parseFileTarget({ attachment: 'not-an-id' })).toBeNull()
    expect(targetColumns({ kind: 'chat', messageId: MSG, path: PATH })).toEqual({ attachment_id: null, chat_message_id: MSG, chat_file_path: PATH })
    expect(noticeRecord({ kind: 'chat', messageId: MSG, path: PATH })).toEqual({ kind: 'team_chat_file', recordId: MSG })
  })
})

describe('readNewComment', () => {
  it('takes words and a place on a page, or the whole file', () => {
    expect(readNewComment({ body: '  hi ', page: 2, x: 0.5, y: 0.1 })).toEqual({ ok: true, body: 'hi', parent_id: null, page: 2, x: 0.5, y: 0.1 })
    expect(readNewComment({ body: 'hi' })).toEqual({ ok: true, body: 'hi', parent_id: null, page: null, x: null, y: null })
  })

  it('refuses no words, a place off the page, and a reply to no thread; a reply has no place', () => {
    expect(readNewComment({ body: ' ' }).ok).toBe(false)
    expect(readNewComment({ body: 'x', page: 0, x: 0, y: 0 }).ok).toBe(false)
    expect(readNewComment({ body: 'x', page: 1, x: 1.2, y: 0 }).ok).toBe(false)
    expect(readNewComment({ body: 'x', parent_id: 'nope' }).ok).toBe(false)
    expect(readNewComment({ body: 'x', parent_id: ATT, page: 1, x: 0, y: 0 })).toMatchObject({ ok: true, page: null })
  })
})

describe('threads and pins', () => {
  const c = (id: string, at: string, extra: Partial<FileComment> = {}): FileComment => ({
    id,
    parent_id: null,
    page: null,
    x: null,
    y: null,
    body: id,
    mentions: [],
    author_id: null,
    author_name: null,
    via_agent: false,
    resolved_at: null,
    resolved_by: null,
    created_at: at,
    updated_at: at,
    ...extra,
  })
  it('groups replies under their thread, oldest first, and numbers the pinned threads', () => {
    const threads = threadsOfFile([c('r1', '3', { parent_id: 'b' }), c('b', '2', { page: 3, x: 0.1, y: 0.1 }), c('a', '1', { page: 1, x: 0, y: 0 }), c('w', '4'), c('orphan', '5', { parent_id: 'gone' })])
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      ['a', []],
      ['b', ['r1']],
      ['w', []],
    ])
    expect([...pinNumbers(threads)]).toEqual([
      ['a', 1],
      ['b', 2],
    ])
  })
})
