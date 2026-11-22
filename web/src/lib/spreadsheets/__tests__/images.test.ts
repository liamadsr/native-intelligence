import { describe, expect, it } from 'vitest'
import { hashBytes, sniffImageType } from '../images'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0])
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')

describe('sniffImageType', () => {
  it('reads the kind from the magic bytes, not the name', () => {
    expect(sniffImageType(png)).toBe('png')
    expect(sniffImageType(jpeg)).toBe('jpeg')
    expect(sniffImageType(gif)).toBe('gif')
    expect(sniffImageType(webp)).toBe('webp')
  })

  it('refuses an SVG and anything else', () => {
    expect(sniffImageType(svg)).toBeNull()
    expect(sniffImageType(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe('hashBytes', () => {
  it('is stable for the same bytes and differs for others', () => {
    expect(hashBytes(png)).toBe(hashBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])))
    expect(hashBytes(png)).not.toBe(hashBytes(jpeg))
  })
})
