/**
 * The Studio server's pure parts: the digest's stable JSON, script text ⇄ beats, byte ranges over parts, the
 * plain-colour canvas video's container, the router's pattern matching, name-based ids and the thumbnail rule.
 */
import { describe, expect, it } from 'vitest'
import { canvasMp4, canvasSize, yuv709 } from '../canvas-mp4'
import { cacheControlFor, parseRange, partSpans, typeOfKey, attachment } from '../files'
import { uuidFor } from '../ids'
import { matchPattern } from '../router'
import { parseScriptText, scriptText } from '../scripts'
import { docDigest, stableStringify } from '../stable'
import { thumbnailDue } from '../thumbnails'
import { blankSettings } from '../blank'

describe('stableStringify', () => {
  it('orders keys at every level and drops undefined like JSON', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}')
    expect(docDigest({ a: 1, b: 2 })).toBe(docDigest({ b: 2, a: 1 }))
    expect(docDigest({ a: 1 })).not.toBe(docDigest({ a: 2 }))
  })
})

describe('scripts', () => {
  it('reads blocks with an optional [5s] length and Label: line', () => {
    const beats = parseScriptText('[5s] Hook:\nMeet the new planner.\n\nIt books   your week\nfor you.\r\n\n\n[2.5s]Close with the logo.')
    expect(beats).toEqual([
      { text: 'Meet the new planner.', seconds: 5, label: 'Hook' },
      { text: 'It books your week for you.' },
      { text: 'Close with the logo.', seconds: 2.5 },
    ])
    expect(parseScriptText(scriptText({ beats }))).toEqual(beats)
  })
  it('keeps a first line that ends a sentence as words, not a label', () => {
    expect(parseScriptText('This is it.\nReally:')).toEqual([{ text: 'This is it. Really:' }])
  })
})

describe('byte ranges', () => {
  it('reads open, closed, suffix and bad ranges', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-30', 100)).toEqual({ start: 70, end: 99 })
    expect(parseRange('bytes=-300', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=20-10', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('unsatisfiable')
    expect(parseRange('items=0-1', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })
  it('splits a range over the parts it touches', () => {
    expect(partSpans({ start: 5, end: 25 }, 10)).toEqual([
      { index: 0, from: 5, to: 9 },
      { index: 1, from: 0, to: 9 },
      { index: 2, from: 0, to: 5 },
    ])
    expect(partSpans({ start: 10, end: 10 }, 10)).toEqual([{ index: 1, from: 0, to: 0 }])
  })
  it('types files and caches content-addressed ones', () => {
    expect(typeOfKey('assets/x.mp4', 'application/octet-stream')).toBe('video/mp4')
    expect(typeOfKey('thumbs/x.jpg', 'image/jpeg')).toBe('image/jpeg')
    expect(cacheControlFor(`assets/${'a'.repeat(64)}.mp4`)).toContain('immutable')
    expect(cacheControlFor('thumbs/x.jpg')).toBe('private, no-cache')
    expect(attachment('Spring “launch”.mp4')).toMatch(/^attachment; filename="Spring _launch_.mp4"; filename\*=UTF-8''/)
  })
})

describe('the canvas video', () => {
  it('is encoded small at the exact shape of the edit', () => {
    expect(canvasSize(1920, 1080)).toEqual({ width: 256, height: 144 })
    expect(canvasSize(1080, 1920)).toEqual({ width: 144, height: 256 })
    expect(canvasSize(1080, 1350)).toEqual({ width: 200, height: 250 })
    expect(canvasSize(1080, 1080)).toEqual({ width: 256, height: 256 })
    expect(canvasSize(1922, 1080)).toEqual({ width: 1922, height: 1080 })
  })
  it('turns hex into limited-range colour', () => {
    expect(yuv709('#000000')).toEqual({ y: 16, cb: 128, cr: 128 })
    expect(yuv709('#ffffff')).toEqual({ y: 235, cb: 128, cr: 128 })
  })
  it('is an MP4 whose boxes add up, one sample per frame', () => {
    const bytes = canvasMp4({ width: 256, height: 144, fps: 30, frames: 45, color: '#eef0f4' })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const boxes: string[] = []
    for (let at = 0; at < bytes.byteLength; ) {
      const size = view.getUint32(at)
      boxes.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)))
      at += size
      if (at === bytes.byteLength) break
      expect(at).toBeLessThan(bytes.byteLength)
    }
    expect(boxes).toEqual(['ftyp', 'moov', 'mdat'])
    const text = new TextDecoder('latin1').decode(bytes)
    const stsz = text.indexOf('stsz')
    expect(view.getUint32(stsz + 12)).toBe(45)
    const stco = text.indexOf('stco')
    expect(String.fromCharCode(...bytes.subarray(view.getUint32(stco + 12) - 4, view.getUint32(stco + 12)))).toBe('mdat')
  })
  it('clamps blank settings as the dialog does', () => {
    expect(blankSettings({ width: 1081, height: 30, fps: 90, seconds: 0, color: 'red' })).toMatchObject({ width: 1082, height: 64, fps: 60, seconds: 1, color: '#eef0f4', title: 'Blank canvas' })
  })
})

describe('router patterns', () => {
  it('matches literal, parameter and rest segments', () => {
    expect(matchPattern('projects/:id/versions/:v/restore', ['projects', 'x', 'versions', '9', 'restore'])).toEqual({ id: 'x', v: '9' })
    expect(matchPattern('projects/:id', ['projects', 'x', 'digest'])).toBeNull()
    expect(matchPattern('review/:name/*file', ['review', 'n', 'scenes', 'a.png'])).toEqual({ name: 'n', file: 'scenes/a.png' })
    expect(matchPattern('review/:name/*file', ['review', 'n'])).toBeNull()
  })
})

describe('ids and thumbnails', () => {
  it('makes the same UUID from the same name', () => {
    expect(uuidFor('a:tiktok')).toBe(uuidFor('a:tiktok'))
    expect(uuidFor('a:tiktok')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('queues a thumbnail once per version, never beside an open one, and not too often', () => {
    const now = Date.parse('2031-03-01T10:00:00Z')
    expect(thumbnailDue('d1', false, [], now)).toBe(true)
    expect(thumbnailDue('d1', false, [{ id: 'j', status: 'queued', created_at: '2031-03-01T09:00:00Z', digest: 'd0' }], now)).toBe(false)
    expect(thumbnailDue('d1', false, [{ id: 'j', status: 'failed', created_at: '2031-03-01T09:00:00Z', digest: 'd1' }], now)).toBe(false)
    expect(thumbnailDue('d2', true, [{ id: 'j', status: 'completed', created_at: '2031-03-01T09:59:00Z', digest: 'd1' }], now)).toBe(false)
    expect(thumbnailDue('d2', true, [{ id: 'j', status: 'completed', created_at: '2031-03-01T09:50:00Z', digest: 'd1' }], now)).toBe(true)
  })
})
