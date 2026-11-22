import { describe, expect, it } from 'vitest'
import { recordRefs, touchesRecords } from '../links'
import { isCanvasMediaPath, canvasMediaPath, canvasMediaKind, canvasMediaUrl } from '../media'
import { itemToRow, rowToItem, type MediaItem } from '../types'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const F = '33333333-3333-4333-8333-333333333333'

describe('record cards as links', () => {
  it('names each record once, and only real, mentionable ones', () => {
    const refs = recordRefs([
      { kind: 'record', data: { ref: { type: 'document', id: A } } },
      { kind: 'record', data: { ref: { type: 'document', id: A, label: 'again' } } },
      { kind: 'record', data: { ref: { type: 'action', id: B } } },
      { kind: 'record', data: { ref: { type: 'not_a_kind', id: B } } },
      { kind: 'record', data: { ref: { type: 'document', id: 'not-an-id' } } },
      { kind: 'record', data: {} },
      { kind: 'rectangle', data: { ref: { type: 'document', id: B } } },
    ])
    expect(refs).toEqual([
      { type: 'document', id: A },
      { type: 'action', id: B },
    ])
  })

  it('syncs links only for a write that could change the cards', () => {
    expect(touchesRecords({ upsert: [{ kind: 'rectangle' }] })).toBe(false)
    expect(touchesRecords({ upsert: [{ kind: 'record' }] })).toBe(true)
    expect(touchesRecords({ remove: ['x'] })).toBe(true)
    expect(touchesRecords({})).toBe(false)
  })
})

describe('canvas media', () => {
  it('owns only paths under its own workspace and canvas', () => {
    const path = canvasMediaPath(A, B, F, 'png')
    expect(path).toBe(`canvas/${A}/${B}/${F}.png`)
    expect(isCanvasMediaPath(path, A, B)).toBe(true)
    expect(isCanvasMediaPath(path, A, A)).toBe(false)
    expect(isCanvasMediaPath(path, B, B)).toBe(false)
    expect(isCanvasMediaPath(`canvas/${A}/${B}/../${B}/${F}.png`, A, B)).toBe(false)
    expect(isCanvasMediaPath(`${A}/${B}/${F}.png`, A, B)).toBe(false)
    expect(isCanvasMediaPath(`canvas/${A}/${B}/${F}.svg`, A, B)).toBe(false)
    expect(isCanvasMediaPath(null, A, B)).toBe(false)
    expect(canvasMediaUrl(B, path)).toBe(`/api/account/canvases/${B}/media?path=${encodeURIComponent(path)}`)
  })

  it('takes images and video, not other files', () => {
    expect(canvasMediaKind('image/PNG')).toBe('image')
    expect(canvasMediaKind('video/mp4')).toBe('video')
    expect(canvasMediaKind('image/svg+xml')).toBeNull()
    expect(canvasMediaKind('application/pdf')).toBeNull()
  })

  it('never saves a local preview address', () => {
    const item: MediaItem = { id: 'm1', parentId: null, sortKey: 'a1', kind: 'image', x: 0, y: 0, w: 10, h: 10, rotation: 0, style: {}, naturalW: 10, naturalH: 10, src: 'blob:http://localhost/abc', path: 'canvas/x' }
    const row = itemToRow(B, item)
    expect(row.data.src).toBeUndefined()
    expect(row.data.path).toBe('canvas/x')
    expect((rowToItem(row) as MediaItem).src).toBeUndefined()
    // The item itself is untouched.
    expect(item.src).toBe('blob:http://localhost/abc')
  })
})
