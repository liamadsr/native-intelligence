import { describe, it, expect } from 'vitest'
import { CHAT_IMAGE_NOT_SHOWN, CHAT_IMAGE_TOOL_NAMES, chatImageModelOutput } from '../chat-image-output'

const B64 = 'QUJDREVGR0g='

/** read_chat_file's result on a photo (src/lib/ai/tools/attachments.ts). */
const photo = (extra: Record<string, unknown> = {}) => ({
  success: true,
  file_name: 'shot.png',
  mime_type: 'image/jpeg',
  width: 1568,
  height: 784,
  __imageBase64: B64,
  __imageMimeType: 'image/jpeg',
  ...extra,
})

describe('chatImageModelOutput', () => {
  it('read_chat_file is the tool it shapes', () => {
    expect([...CHAT_IMAGE_TOOL_NAMES]).toEqual(['read_chat_file'])
  })

  it('a model that reads images gets the JSON without the base64, then the photo as a file part', () => {
    const out = chatImageModelOutput(photo(), true)
    expect(out.type).toBe('content')
    if (out.type !== 'content') return
    const [text, file] = out.value
    expect(text.type).toBe('text')
    if (text.type !== 'text') return
    expect(text.text).not.toContain(B64)
    expect(JSON.parse(text.text)).toEqual({
      success: true,
      file_name: 'shot.png',
      mime_type: 'image/jpeg',
      width: 1568,
      height: 784,
      image: 'attached as an image',
    })
    expect(file).toEqual({ type: 'file', data: { type: 'data', data: B64 }, mediaType: 'image/jpeg' })
  })

  it('any other model gets a note in its place, never the base64 as text', () => {
    const out = chatImageModelOutput(photo(), false)
    expect(out).toEqual({
      type: 'json',
      value: { success: true, file_name: 'shot.png', mime_type: 'image/jpeg', width: 1568, height: 784, image: CHAT_IMAGE_NOT_SHOWN },
    })
    expect(JSON.stringify(out)).not.toContain(B64)
  })

  it('a text file, a refusal or nothing passes through as JSON', () => {
    expect(chatImageModelOutput({ success: true, content: '# notes' }, true)).toEqual({ type: 'json', value: { success: true, content: '# notes' } })
    expect(chatImageModelOutput({ success: false, error: 'nope' }, true)).toEqual({ type: 'json', value: { success: false, error: 'nope' } })
    expect(chatImageModelOutput(undefined, true)).toEqual({ type: 'json', value: null })
  })

  it('a photo with no type is attached as a JPEG', () => {
    const out = chatImageModelOutput(photo({ __imageMimeType: undefined }), true)
    if (out.type !== 'content') throw new Error('expected content')
    expect(out.value[1]).toMatchObject({ type: 'file', mediaType: 'image/jpeg' })
  })
})
