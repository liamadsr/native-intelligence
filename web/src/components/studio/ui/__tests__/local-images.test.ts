/**
 * Pictures from a folder on this computer are measured before anything decodes them (../local-images.ts): a small
 * file can hold an enormous picture (a few MB of PNG at 40,000 × 40,000 pixels is 6.4 GB decoded), and a linked
 * folder's rows make thumbnails on their own. What must hold: the size comes from the header for PNG, JPEG, GIF,
 * WebP and BMP; a picture over the pixel budget is refused before any <img> or createImageBitmap sees it, both when
 * a thumbnail is made and when a still is converted to be added; a small one is drawn at the thumbnail's size.
 * Made-up bytes only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkedPicture, MAX_PIXELS, pictureSize, PictureTooLarge, sizeFromHeader } from '../local-images'
import { convertStill, importableFile } from '../local-folders'
import { stillThumb } from '../local-thumbs'

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap(p => typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p))
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >> 8) & 255]
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255]
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
const png = (w: number, h: number) => bytes([0x89], 'PNG', [13, 10, 26, 10], be32(13), 'IHDR', be32(w), be32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0])
const gif = (w: number, h: number) => bytes('GIF89a', le16(w), le16(h), [0, 0, 0])
const file = (data: Uint8Array, name: string) => new File([data as BlobPart], name)

describe('sizeFromHeader', () => {
  it('reads PNG, GIF and BMP headers', () => {
    expect(sizeFromHeader(png(40000, 30000))).toEqual({ width: 40000, height: 30000 })
    expect(sizeFromHeader(gif(640, 480))).toEqual({ width: 640, height: 480 })
    expect(sizeFromHeader(bytes('BM', new Array(16).fill(0), le32(1200), le32(-800 >>> 0), [0, 0]))).toEqual({ width: 1200, height: 800 })
  })
  it('reads the three kinds of WebP', () => {
    expect(sizeFromHeader(bytes('RIFF', le32(0), 'WEBP', 'VP8X', le32(10), le32(0), le24(4095), le24(2047)))).toEqual({ width: 4096, height: 2048 })
    // VP8L: 14 bits each of width-1 and height-1, after the 0x2f signature.
    const w = 999, h = 499, bits = (w) | (h << 14)
    expect(sizeFromHeader(bytes('RIFF', le32(0), 'WEBP', 'VP8L', le32(0), [0x2f], le32(bits), [0]))).toEqual({ width: 1000, height: 500 })
    expect(sizeFromHeader(bytes('RIFF', le32(0), 'WEBP', 'VP8 ', le32(0), [0, 0, 0], [0x9d, 0x01, 0x2a], le16(1920), le16(1080), [0]))).toEqual({ width: 1920, height: 1080 })
  })
  it('walks a JPEG’s segments to its frame header', () => {
    const exif = new Array(300).fill(0)
    const jpeg = bytes([0xff, 0xd8], [0xff, 0xe0, 0, 16], new Array(14).fill(0), [0xff, 0xe1, 302 >> 8, 302 & 255], exif, [0xff, 0xc2, 0, 17, 8], [0x0f, 0xa0], [0x17, 0x70], new Array(12).fill(0))
    expect(sizeFromHeader(jpeg)).toEqual({ width: 6000, height: 4000 })
  })
  it('knows nothing of other formats', () => {
    expect(sizeFromHeader(bytes('....ftypheic'))).toBeNull()
  })
})

describe('pictureSize and checkedPicture', () => {
  it('measure an unknown format only when its header says nothing', async () => {
    const measure = vi.fn(async () => ({ width: 10, height: 10 }))
    expect(await pictureSize(file(png(5, 5), 'a.png'), measure)).toEqual({ width: 5, height: 5 })
    expect(measure).not.toHaveBeenCalled()
    expect(await pictureSize(file(bytes('....ftypheic'), 'a.heic'), measure)).toEqual({ width: 10, height: 10 })
  })
  it('refuse a picture over the budget', async () => {
    await expect(checkedPicture(file(png(40000, 40000), 'huge.png'))).rejects.toBeInstanceOf(PictureTooLarge)
    expect(await checkedPicture(file(png(8000, 8000), 'ok.png'))).toEqual({ width: 8000, height: 8000 })
    expect(8000 * 8000).toBeLessThanOrEqual(MAX_PIXELS)
  })
})

describe('nothing decodes an enormous picture', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const stubDecoders = () => {
    const image = vi.fn(), bitmap = vi.fn(async () => ({ close() {} })), objectUrl = vi.fn(() => 'blob:x')
    vi.stubGlobal('Image', image); vi.stubGlobal('createImageBitmap', bitmap)
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: objectUrl, revokeObjectURL: () => {} }))
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (done: (b: Blob) => void) => done(new Blob(['thumb'])) }
    vi.stubGlobal('document', { createElement: () => canvas })
    return { image, bitmap, objectUrl }
  }

  it('a thumbnail of a tiny PNG file holding 40,000 × 40,000 pixels is never made', async () => {
    const { image, bitmap, objectUrl } = stubDecoders()
    expect(await stillThumb(file(png(40000, 40000), 'bomb.png'))).toBeNull()
    expect(image).not.toHaveBeenCalled(); expect(bitmap).not.toHaveBeenCalled(); expect(objectUrl).not.toHaveBeenCalled()
  })

  it('a small picture is decoded straight to the thumbnail’s size', async () => {
    const { bitmap } = stubDecoders()
    expect(await stillThumb(file(png(400, 200), 'small.png'))).toBeInstanceOf(Blob)
    expect(bitmap).toHaveBeenCalledWith(expect.any(File), { resizeWidth: 192, resizeHeight: 96, resizeQuality: 'medium' })
  })

  it('converting an enormous still to add it is refused before it is opened', async () => {
    const { image, objectUrl } = stubDecoders()
    await expect(convertStill(file(gif(40000, 40000), 'bomb.gif'))).rejects.toBeInstanceOf(PictureTooLarge)
    await expect(importableFile(file(gif(40000, 40000), 'bomb.gif'))).rejects.toThrow('too large a picture to open here')
    expect(image).not.toHaveBeenCalled(); expect(objectUrl).not.toHaveBeenCalled()
  })
})
