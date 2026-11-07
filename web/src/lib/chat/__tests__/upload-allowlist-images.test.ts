/**
 * isChatImageUpload (bots v4): the composer of a chat that can't take photos
 * yet (a run's chat, a teammate's thread) refuses what this calls a photo or
 * image, by its name's extension or its declared type; the text-only `accept`
 * offers no image type.
 */
import { describe, it, expect } from 'vitest'
import { isChatImageUpload, UPLOAD_ACCEPT_ATTR, UPLOAD_TEXT_ACCEPT_ATTR } from '../upload-allowlist'

describe('isChatImageUpload', () => {
  it('is an image by its extension, any case, an SVG too', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'logo.svg']) expect(isChatImageUpload({ name }), name).toBe(true)
  })

  it('or by its declared type (a pasted screenshot has no extension)', () => {
    expect(isChatImageUpload({ name: 'image', type: 'image/png' })).toBe(true)
    expect(isChatImageUpload({ name: 'clip', type: 'IMAGE/HEIC' })).toBe(true)
  })

  it('a text file is not', () => {
    expect(isChatImageUpload({ name: 'notes.md', type: 'text/markdown' })).toBe(false)
    expect(isChatImageUpload({ name: 'data.csv' })).toBe(false)
    expect(isChatImageUpload({ name: 'noext' })).toBe(false)
  })

  it('the text-only accept offers no image type; the main chat’s still does', () => {
    expect(UPLOAD_TEXT_ACCEPT_ATTR).not.toContain('image')
    expect(UPLOAD_TEXT_ACCEPT_ATTR).toContain('.md')
    expect(UPLOAD_ACCEPT_ATTR).toContain('image/*')
  })
})
