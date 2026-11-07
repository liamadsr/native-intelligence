/**
 * Photos a tool hands the model (../tool-image.ts) and read_chat_file's photo
 * path (../attachments.ts): the chat's photos reach the model only this way,
 * never as a file part on the message, which makes eve provision a sandbox.
 */
import { describe, it, expect, vi } from 'vitest'
import { wrapUntrusted } from '@/lib/email/untrusted'
import sharp from 'sharp'
import type { ToolExecutionOptions } from 'ai'
import { createAttachmentTools } from '../attachments'
import { MODEL_IMAGE_MAX_EDGE, TOOL_IMAGE_NOT_SHOWN, imageForModel, withoutToolImage } from '../tool-image'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const USER = '11111111-1111-4111-8111-111111111111'
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

/** A plain image of the given size, as the bytes of `format`. */
function picture(width: number, height: number, format: 'png' | 'jpeg' = 'png', alpha = false) {
  return sharp({
    create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 30, b: 30, alpha: 0.5 } : { r: 200, g: 30, b: 30 } },
  })
    [format]()
    .toBuffer()
}

describe('withoutToolImage', () => {
  it('takes the image out and says so; anything without one is left as it was', () => {
    expect(withoutToolImage({ success: true, file_name: 'a.png', __imageBase64: 'AAAA', __imageMimeType: 'image/png' })).toEqual({
      success: true,
      file_name: 'a.png',
      image: TOOL_IMAGE_NOT_SHOWN,
    })
    const plain = { success: true, content: 'text' }
    expect(withoutToolImage(plain)).toBe(plain)
    expect(withoutToolImage(null)).toBeNull()
    expect(withoutToolImage('x')).toBe('x')
    expect(withoutToolImage([1])).toEqual([1])
  })
})

describe('imageForModel', () => {
  it('a phone-sized photo is scaled to fit the longest edge, as a JPEG', async () => {
    const image = await imageForModel(await picture(4032, 3024, 'jpeg'))
    expect(image).toMatchObject({ mediaType: 'image/jpeg', width: MODEL_IMAGE_MAX_EDGE, height: 1176 })
    expect((await sharp(Buffer.from(image!.base64, 'base64')).metadata()).format).toBe('jpeg')
  })

  it('a small image keeps its size; a transparent one is flattened on white', async () => {
    expect(await imageForModel(await picture(300, 200))).toMatchObject({ mediaType: 'image/jpeg', width: 300, height: 200 })
    const flat = await imageForModel(await picture(10, 10, 'png', true))
    const { channels } = await sharp(Buffer.from(flat!.base64, 'base64')).metadata()
    expect(channels).toBe(3)
  })

  it('bytes that are no image: null', async () => {
    expect(await imageForModel(Buffer.from('not an image at all'))).toBeNull()
  })
})

describe('read_chat_file on a photo', () => {
  function storage(bytes: Buffer) {
    const download = vi.fn(async () => ({ data: new Blob([new Uint8Array(bytes)]), error: null }))
    return { client: { from: vi.fn(), storage: { from: vi.fn(() => ({ download })) } } as never, download }
  }

  it('hands back the scaled image under the transport keys, with its size', async () => {
    const { client, download } = storage(await picture(3000, 1500, 'png'))
    const tools = createAttachmentTools(USER, client, 'ws-1')
    const res = (await tools.read_chat_file.execute!({ storage_path: `${USER}/chat-uploads/shot.png` }, EXEC)) as Record<string, unknown>
    expect(download).toHaveBeenCalledWith(`${USER}/chat-uploads/shot.png`)
    expect(res).toMatchObject({
      success: true,
      file_name: 'shot.png',
      file_extension: 'png',
      mime_type: 'image/jpeg',
      width: MODEL_IMAGE_MAX_EDGE,
      height: 784,
      __imageMimeType: 'image/jpeg',
    })
    expect(typeof res.__imageBase64).toBe('string')
  })

  it('a file named like a photo that is no image says it can’t be shown', async () => {
    const { client } = storage(Buffer.from('plain text pretending'))
    const tools = createAttachmentTools(USER, client, 'ws-1')
    const res = (await tools.read_chat_file.execute!({ storage_path: `${USER}/chat-uploads/fake.jpg` }, EXEC)) as Record<string, unknown>
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/can't be shown/) })
  })

  it('an SVG stays text, which every model reads', async () => {
    const { client } = storage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    const tools = createAttachmentTools(USER, client, 'ws-1')
    const res = (await tools.read_chat_file.execute!({ storage_path: `${USER}/chat-uploads/logo.svg` }, EXEC)) as Record<string, unknown>
    expect(res).toMatchObject({ success: true, content: wrapUntrusted('<svg xmlns="http://www.w3.org/2000/svg"/>', 'FILE') })
    expect(res.__imageBase64).toBeUndefined()
  })
})
