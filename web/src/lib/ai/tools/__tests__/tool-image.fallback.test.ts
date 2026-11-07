/**
 * imageForModel when sharp can't load (../tool-image.ts): no image at all,
 * never the original bytes. An image a provider refuses would stay in the eve
 * session's history and fail every later step, so only a scaled one is shown.
 */
import { describe, it, expect, vi } from 'vitest'
import { imageForModel } from '../tool-image'

vi.mock('sharp', () => {
  throw new Error('sharp is not installed')
})

describe('imageForModel when sharp cannot load', () => {
  it('a JPEG is not passed through unscaled: null', async () => {
    expect(await imageForModel(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBeNull()
  })
})
