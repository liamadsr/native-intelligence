import { describe, it, expect } from 'vitest'
import { SCREENSHOT_NOT_SHOWN, modelReadsToolImages, screenshotModelOutput } from '../screenshot-output'

const B64 = 'QUJDREVGR0g='

/** screenshot_browser's result: the queue row's result, from the desktop relay. */
const shot = (extra: Record<string, unknown> = {}) => ({
  success: true,
  result: { screenshotBase64: B64, mediaType: 'image/jpeg', ...extra },
})

describe('modelReadsToolImages', () => {
  it('is true for Anthropic models, including a bare id (which the model resolver treats as Anthropic)', () => {
    expect(modelReadsToolImages('anthropic/claude-sonnet-4.5')).toBe(true)
    expect(modelReadsToolImages('anthropic/claude-haiku-4.5')).toBe(true)
    expect(modelReadsToolImages('claude-sonnet-4-5-20250929')).toBe(true)
  })

  it('is false for the models that get a tool-result image as text or drop it', () => {
    for (const m of ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'moonshotai/kimi-k2.6', 'moonshotai/kimi-k3']) {
      expect(modelReadsToolImages(m)).toBe(false)
    }
  })

  it('is false when the model is unknown', () => {
    expect(modelReadsToolImages(undefined)).toBe(false)
    expect(modelReadsToolImages(null)).toBe(false)
    expect(modelReadsToolImages('')).toBe(false)
  })
})

describe('screenshotModelOutput', () => {
  it('a model that reads images gets the JSON without the base64, then the image as a file part', () => {
    const out = screenshotModelOutput(shot(), true)
    expect(out.type).toBe('content')
    if (out.type !== 'content') return
    const [text, file] = out.value
    expect(text.type).toBe('text')
    if (text.type !== 'text') return
    expect(text.text).not.toContain(B64)
    expect(JSON.parse(text.text)).toEqual({ success: true, result: { screenshot: 'attached as an image' } })
    expect(file).toEqual({ type: 'file', data: { type: 'data', data: B64 }, mediaType: 'image/jpeg' })
  })

  it('any other model gets the JSON with a note in the image’s place, and no base64 anywhere', () => {
    const out = screenshotModelOutput(shot(), false)
    expect(out).toEqual({ type: 'json', value: { success: true, result: { screenshot: SCREENSHOT_NOT_SHOWN } } })
    expect(JSON.stringify(out)).not.toContain(B64)
  })

  it('keeps the rest of the result, and a wait_for_browser_command result is handled the same way', () => {
    const waited = { success: true, done: true, result: { screenshotBase64: B64, width: 1024 } }
    expect(screenshotModelOutput(waited, false)).toEqual({
      type: 'json',
      value: { success: true, done: true, result: { width: 1024, screenshot: SCREENSHOT_NOT_SHOWN } },
    })
  })

  it('an image without a media type is sent as a JPEG (the desktop always captures JPEG)', () => {
    const out = screenshotModelOutput({ success: true, result: { screenshotBase64: B64 } }, true)
    expect(out.type === 'content' && out.value[1]).toMatchObject({ type: 'file', mediaType: 'image/jpeg' })
  })

  it('a result with no screenshot passes through unchanged', () => {
    const pending = { success: true, pending: true, run_id: 'r1', message: 'still working' }
    expect(screenshotModelOutput(pending, true)).toEqual({ type: 'json', value: pending })
    const failed = { success: false, error: 'Browser command failed.' }
    expect(screenshotModelOutput(failed, false)).toEqual({ type: 'json', value: failed })
    const clicked = { success: true, done: true, result: { ok: true } }
    expect(screenshotModelOutput(clicked, true)).toEqual({ type: 'json', value: clicked })
    expect(screenshotModelOutput({ success: true, result: { screenshotBase64: '' } }, true)).toEqual({
      type: 'json',
      value: { success: true, result: { screenshotBase64: '' } },
    })
  })

  it('odd outputs pass through instead of throwing', () => {
    expect(screenshotModelOutput(undefined, true)).toEqual({ type: 'json', value: null })
    expect(screenshotModelOutput('text', false)).toEqual({ type: 'json', value: 'text' })
    expect(screenshotModelOutput([1, 2], true)).toEqual({ type: 'json', value: [1, 2] })
  })
})
