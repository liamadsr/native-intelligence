/** Clearing a canvas's files when the canvas is deleted for good. */
import { describe, expect, it } from 'vitest'
import { isCanvasMediaPath, removeCanvasMedia, type MediaBucket } from '../media'

const WS = '11111111-1111-4111-8111-111111111111'
const C = '33333333-3333-4333-8333-333333333333'
const F = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}.png`

function bucket(files: string[], fail: { list?: string; remove?: string } = {}) {
  const calls: Array<{ op: string; arg: unknown }> = []
  let left = [...files]
  const b: MediaBucket = {
    async list(path, options) {
      calls.push({ op: 'list', arg: path })
      if (fail.list) return { data: null, error: { message: fail.list } }
      return { data: left.slice(0, options.limit).map((name) => ({ name })), error: null }
    },
    async remove(paths) {
      calls.push({ op: 'remove', arg: paths })
      if (fail.remove) return { error: { message: fail.remove } }
      const gone = new Set(paths.map((p) => p.split('/').pop()))
      left = left.filter((n) => !gone.has(n))
      return { error: null }
    },
  }
  return { b, calls, left: () => left }
}

describe('removing a deleted canvas\'s files', () => {
  it('removes every file in the canvas\'s own folder, and nothing else', async () => {
    const { b, calls, left } = bucket([F(1), F(2), 'notes.txt', '.emptyFolderPlaceholder'])
    const r = await removeCanvasMedia(b, WS, C)
    expect(r).toEqual({ removed: 2, error: null })
    expect(calls[0]).toEqual({ op: 'list', arg: `canvas/${WS}/${C}` })
    expect(calls[1].arg).toEqual([`canvas/${WS}/${C}/${F(1)}`, `canvas/${WS}/${C}/${F(2)}`])
    expect(left()).toEqual(['notes.txt', '.emptyFolderPlaceholder'])
    for (const p of calls[1].arg as string[]) expect(isCanvasMediaPath(p, WS, C)).toBe(true)
  })

  it('empties a big folder a page at a time', async () => {
    const { b, left } = bucket(Array.from({ length: 2300 }, (_, i) => F(i)))
    expect(await removeCanvasMedia(b, WS, C)).toEqual({ removed: 2300, error: null })
    expect(left()).toHaveLength(0)
  })

  it('touches nothing for ids that are not a canvas folder', async () => {
    const { b, calls } = bucket([F(1)])
    expect((await removeCanvasMedia(b, WS, '../other')).error).toBe('Not a canvas folder')
    expect((await removeCanvasMedia(b, '', C)).error).toBe('Not a canvas folder')
    expect(calls).toHaveLength(0)
  })

  it('reports a failure instead of throwing', async () => {
    expect(await removeCanvasMedia(bucket([F(1)], { list: 'down' }).b, WS, C)).toEqual({ removed: 0, error: 'down' })
    expect(await removeCanvasMedia(bucket([F(1)], { remove: 'denied' }).b, WS, C)).toEqual({ removed: 0, error: 'denied' })
  })
})
