import { describe, expect, it } from 'vitest'
import type { CanvasItem } from '../../types'
import { ARTIFACT_CSP, ARTIFACT_LIMITS, ARTIFACT_SANDBOX, artifactDocument, artifactTitle, presentOrder } from '../artifact'
import { sceneFromItems } from '../scene'

describe('the document an artifact\'s frame is given', () => {
  it('puts the policy ahead of everything the artifact wrote', () => {
    const doc = artifactDocument('<script>fetch("https://example.test")</script><h1>Hi</h1>')
    const policy = doc.indexOf('http-equiv="Content-Security-Policy"')
    expect(policy).toBeGreaterThan(-1)
    expect(policy).toBeLessThan(doc.indexOf('<script>'))
    expect(doc.startsWith('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(doc).toContain('<h1>Hi</h1>')
  })

  it('turns the network off: nothing by default, inline script and style, data: images, fonts and media, no forms, no base', () => {
    expect(ARTIFACT_CSP).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'")
    // No source that reaches a server, in any directive.
    expect(ARTIFACT_CSP).not.toMatch(/https?:|\*|'self'|blob:|'unsafe-eval'/)
    // connect-src, frame-src, worker-src and object-src are not named, so they fall to default-src 'none'.
    for (const d of ['connect-src', 'frame-src', 'worker-src', 'object-src']) expect(ARTIFACT_CSP).not.toContain(d)
    expect(artifactDocument('x')).toContain(`content="${ARTIFACT_CSP}"`)
  })

  it('gives the frame script and nothing else', () => {
    expect(ARTIFACT_SANDBOX).toBe('allow-scripts')
  })

  it('caps what it will draw and survives what is not a string', () => {
    const long = 'a'.repeat(ARTIFACT_LIMITS.html + 500)
    expect(artifactDocument(long).match(/a{10,}/)?.[0].length).toBe(ARTIFACT_LIMITS.html)
    expect(artifactDocument(undefined as unknown as string)).toContain('<body></body>')
    expect(artifactDocument('x', { dark: true })).toContain('content="dark"')
  })

  it('makes a title one trimmed line, or nothing', () => {
    expect(artifactTitle('  Q4\n  plan  ')).toBe('Q4 plan')
    expect(artifactTitle('   ')).toBeUndefined()
    expect(artifactTitle(7)).toBeUndefined()
    expect(artifactTitle('t'.repeat(500))?.length).toBe(ARTIFACT_LIMITS.title)
  })
})

describe('the order artifacts are presented in', () => {
  const art = (id: string, x: number, y: number, presentOrder?: string): CanvasItem =>
    ({ id, kind: 'artifact', parentId: null, sortKey: `a${id}`, x, y, w: 400, h: 300, rotation: 0, style: {}, html: '', ...(presentOrder ? { presentOrder } : {}) }) as CanvasItem
  const box = (id: string): CanvasItem => ({ id, kind: 'rectangle', parentId: null, sortKey: `b${id}`, x: 0, y: 0, w: 10, h: 10, rotation: 0, style: {} }) as CanvasItem

  it('reads rows top to bottom and left to right, artifacts only', () => {
    const scene = sceneFromItems([art('d', 500, 420), art('b', 500, 10), box('x'), art('a', 0, 0), art('c', 0, 400)])
    expect(presentOrder(scene).map((a) => a.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('puts the ones with a present key first, by that key', () => {
    const scene = sceneFromItems([art('a', 0, 0), art('z', 900, 900, 'a1'), art('y', 900, 0, 'a2'), art('b', 500, 0)])
    expect(presentOrder(scene).map((a) => a.id)).toEqual(['z', 'y', 'a', 'b'])
  })

  it('is empty for a canvas with none', () => {
    expect(presentOrder(sceneFromItems([box('x')]))).toEqual([])
  })
})
