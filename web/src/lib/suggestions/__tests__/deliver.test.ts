import { describe, it, expect } from 'vitest'
import { placeMarkers, SUGGESTED_CHANGES_HEADING } from '../deliver'

const A = '3f9a12c4-0000-4000-8000-00000000000a'
const B = '3f9a12c4-0000-4000-8000-00000000000b'

describe('placeMarkers', () => {
  it('leaves a document that places every suggestion alone', () => {
    const md = `GEN-297 is overdue.\n<!-- proposal:${A} -->\n`
    expect(placeMarkers(md, [A])).toBe(md)
  })

  it('appends the missing ones under Suggested changes', () => {
    const md = `GEN-297 is overdue.\n<!-- proposal:${A} -->`
    const out = placeMarkers(md, [A, B])
    expect(out).toBe(`${md}\n\n${SUGGESTED_CHANGES_HEADING}\n\n<!-- proposal:${B} -->\n`)
  })

  it('reuses an existing heading', () => {
    const md = `Body\n\n${SUGGESTED_CHANGES_HEADING}\n\n<!-- proposal:${A} -->`
    expect(placeMarkers(md, [A, B])).toBe(`${md}\n\n<!-- proposal:${B} -->\n`)
  })
})
