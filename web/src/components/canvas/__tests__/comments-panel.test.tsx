import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CanvasItem } from '@/lib/canvas/types'
import { threadsOf, type CanvasComment } from '@/lib/canvas/comments'
import { CommentPins, CommentsButton, CommentsPanel, type CanvasComments } from '../comments-panel'
import { CanvasStore } from '../store'
import { CanvasContext } from '../use-canvas'

const ME = 'm-1'
const box = (id: string, x: number): CanvasItem => ({ id, kind: 'rectangle', parentId: null, sortKey: `a${id}`, x, y: 40, w: 100, h: 60, rotation: 0, style: {} }) as unknown as CanvasItem
const c = (id: string, extra: Partial<CanvasComment> = {}): CanvasComment => ({
  id,
  canvas_id: 'c',
  parent_id: null,
  item_id: null,
  x: null,
  y: null,
  body: `Body of ${id}`,
  author_id: ME,
  author_name: 'Ada Example',
  resolved_at: null,
  resolved_by: null,
  created_at: '2026-11-20T10:00:00Z',
  updated_at: '2026-11-20T10:00:00Z',
  ...extra,
})

const never = async () => null
function comments(list: CanvasComment[], state: CanvasComments['state'] = 'ready'): CanvasComments {
  const threads = threadsOf(list)
  return { state, threads, me: ME, open: threads.filter((t) => !t.root.resolved_at).length, add: never, resolve: never, edit: never, remove: never }
}

function draw(node: React.ReactNode, items: CanvasItem[] = [box('a', 100)], selection: string[] = []) {
  const store = new CanvasStore('c', items)
  store.setViewport(800, 600)
  if (selection.length) store.select(selection)
  return renderToStaticMarkup(<CanvasContext.Provider value={store}>{node}</CanvasContext.Provider>)
}

const LIST = [
  c('t1', { item_id: 'a', body: 'Move <b>this</b> left' }),
  c('r1', { parent_id: 't1', author_id: 'm-2', author_name: 'Ben Example', body: 'Agreed', created_at: '2026-11-20T10:05:00Z' }),
  c('t2', { body: 'About the whole board', author_id: 'm-2', author_name: 'Ben Example', created_at: '2026-11-20T11:00:00Z' }),
  c('t3', { body: 'Old news', resolved_at: '2026-11-21T09:00:00Z', resolved_by: 'm-2', created_at: '2026-11-20T12:00:00Z' }),
  c('t4', { item_id: 'gone', body: 'On a deleted shape', created_at: '2026-11-20T13:00:00Z' }),
]

describe('the comments panel', () => {
  it('lists open threads with their replies, as text, and hides resolved ones behind a count', () => {
    const html = draw(<CommentsPanel comments={comments(LIST)} focus={null} onFocus={() => {}} onClose={() => {}} />)
    expect(html).toContain('Move &lt;b&gt;this&lt;/b&gt; left')
    expect(html).toContain('Agreed')
    expect(html).toContain('About the whole board')
    expect(html).not.toContain('Old news')
    expect(html).toContain('Show resolved (1)')
    expect(html).toContain('On an item: show it')
    expect(html).toContain('On an item that was deleted')
    expect(html).toContain('Comment on the canvas…')
  })

  it('offers delete only on the caller\'s own comments', () => {
    const html = draw(<CommentsPanel comments={comments(LIST)} focus={null} onFocus={() => {}} onClose={() => {}} />)
    // t1 and t4 are the caller's; r1 and t2 are someone else's.
    expect(html.match(/aria-label="Delete comment"/g)).toHaveLength(2)
    expect(html.match(/aria-label="Edit comment"/g)).toHaveLength(2)
  })

  it('aims a new comment at the one selected item, shows a focused resolved thread, and says when it cannot load', () => {
    const picked = draw(<CommentsPanel comments={comments(LIST)} focus="t3" onFocus={() => {}} onClose={() => {}} />, [box('a', 100)], ['a'])
    expect(picked).toContain('Comment on the selected item…')
    expect(picked).toContain('Old news')
    expect(picked).toContain('Reopen')
    expect(draw(<CommentsPanel comments={comments([], 'error')} focus={null} onFocus={() => {}} onClose={() => {}} />)).toContain('could not be loaded')
    expect(draw(<CommentsPanel comments={comments([])} focus={null} onFocus={() => {}} onClose={() => {}} />)).toContain('No comments yet')
  })
})

describe('the comments button and pins', () => {
  it('counts open threads, and is not there while comments are off', () => {
    expect(draw(<CommentsButton comments={comments(LIST)} pressed={false} onClick={() => {}} />)).toContain('aria-label="Comments, 3 open"')
    expect(draw(<CommentsButton comments={comments([])} pressed onClick={() => {}} />)).toContain('aria-label="Comments"')
    expect(draw(<CommentsButton comments={comments([], 'off')} pressed={false} onClick={() => {}} />)).toBe('')
  })

  it('pins an item that has an open thread, at its corner, with the count; never a deleted item or a resolved thread', () => {
    const html = draw(<CommentPins comments={comments([...LIST, c('t5', { item_id: 'b', resolved_at: '2026-11-21T09:00:00Z' })])} onOpen={() => {}} />, [box('a', 100), box('b', 400)])
    expect(html.match(/data-canvas-comment-pin=/g)).toHaveLength(1)
    expect(html).toContain('data-canvas-comment-pin="a"')
    expect(html).toContain('aria-label="2 comments on this item"')
    expect(draw(<CommentPins comments={comments([c('t2')])} onOpen={() => {}} />)).toBe('')
  })
})
