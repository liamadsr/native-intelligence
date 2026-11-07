import { describe, expect, it } from 'vitest'
import { mergeFrameObservations, restrictedFrame } from '../frame-observation'
import { observationSchema } from '../task-contract'

const control = (ref: string, name: string, point?: { x: number; y: number }) => ({ ref, role: 'button', name, value: '', canType: false,
  disabled: false, sensitive: false, forbidden: false, context: '', destination: '', ...(point ? { point } : {}) })
const document = (extra: Record<string, unknown> = {}) => ({ protocol: 'dial8-browser-decision-v1', documentId: 'main-doc', observationId: 3,
  interactionEpoch: 1, observedAt: 1, url: 'https://shop.example/', title: 'Shop', text: 'Main text', readyState: 'complete', loading: false,
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, scrollWidth: 800, scrollHeight: 600 },
  evidence: { headings: [], dialogs: [], dialogsComplete: true, currentFields: [], currentFieldsScope: 'rendered_form_state', currentFieldsTruncated: false },
  elements: [control('e1', 'Main button')], ...extra })
const frame = (path: number[], origin: string, extra: Record<string, unknown> = {}) => ({ ...document(), documentId: `doc-${path.join('.')}`,
  observationId: 7, interactionEpoch: 2, url: `${origin}/widget`, text: `Text of ${origin}`, framePath: path, origin,
  elements: [control('e1', `Book ${path.join('.')}`, { x: 30, y: 20 })], ...extra })

describe('one observation from the page and its embedded frames', () => {
  it('passes an older runtime observation and startup sentinels through unchanged', () => {
    const plain = document()
    expect(mergeFrameObservations(plain)).toBe(plain)
    const sentinel = { error: 'agent runtime not present' }
    expect(mergeFrameObservations({ main: sentinel, frames: [], inputCapable: true })).toBe(sentinel)
  })

  it('places a frame by its iframe box, scopes its refs and records its identity', () => {
    const merged = observationSchema.parse(mergeFrameObservations({ inputCapable: true,
      main: document({ childFrames: [{ index: 0, x: 100, y: 200, width: 300, height: 150, visible: true }] }),
      frames: [frame([0], 'https://widget.example')] }))
    expect(merged.trustedInput).toBe(true)
    expect(merged.elements.map(element => element.ref)).toEqual(['e1', 'f0e1'])
    expect(merged.elements[1]).toMatchObject({ name: 'Book 0', frame: 'f0', point: { x: 130, y: 220 } })
    expect(merged.frames).toEqual([{ key: 'f0', path: [0], origin: 'https://widget.example', url: 'https://widget.example/widget',
      documentId: 'doc-0', observationId: 7, interactionEpoch: 2, x: 100, y: 200 }])
    expect(merged.text).toContain('[Embedded frame https://widget.example]\nText of https://widget.example')
    expect(merged).not.toHaveProperty('childFrames')
  })

  it('adds nested offsets and leaves out controls outside the visible part of a frame', () => {
    const merged = observationSchema.parse(mergeFrameObservations({ inputCapable: true,
      main: document({ childFrames: [{ index: 1, x: 700, y: 100, width: 300, height: 300, visible: true }] }),
      frames: [frame([1], 'https://outer.example', { childFrames: [{ index: 0, x: 10, y: 50, width: 200, height: 100, visible: true }],
        elements: [control('e1', 'Visible', { x: 50, y: 20 }), control('e2', 'Beyond the viewport', { x: 150, y: 20 })] }),
        frame([1, 0], 'https://inner.example')] }))
    expect(merged.elements.map(element => element.name)).toEqual(['Main button', 'Visible', 'Book 1.0'])
    expect(merged.elements.find(element => element.name === 'Book 1.0')?.point).toEqual({ x: 740, y: 170 })
    expect(merged.frames?.map(entry => entry.path)).toEqual([[1], [1, 0]])
  })

  it('never offers CAPTCHA, payment or sign-in frames, or anything nested inside them', () => {
    for (const [origin, url] of [['https://js.stripe.com', ''], ['https://www.google.com', 'https://www.google.com/recaptcha/api2/anchor'],
      ['https://accounts.google.com', ''], ['https://checkout.paypal.com', ''], ['https://newassets.hcaptcha.com', '']]) {
      expect(restrictedFrame(origin, url)).toBe(true)
    }
    expect(restrictedFrame('https://www.google.com', 'https://www.google.com/maps/embed')).toBe(false)
    expect(restrictedFrame('https://cookiebot.example', '')).toBe(false)
    const merged = observationSchema.parse(mergeFrameObservations({ inputCapable: true,
      main: document({ childFrames: [{ index: 0, x: 0, y: 0, width: 400, height: 300, visible: true }] }),
      frames: [frame([0], 'https://js.stripe.com', { childFrames: [{ index: 0, x: 0, y: 0, width: 100, height: 100, visible: true }] }),
        frame([0, 0], 'https://nested.example')] }))
    expect(merged.elements.map(element => element.ref)).toEqual(['e1'])
    expect(merged.frames).toBeUndefined()
    expect(merged.text).not.toContain('Embedded frame')
  })

  it('leaves out frames from a site the user blocked, text and all, and anything inside them', () => {
    const merged = observationSchema.parse(mergeFrameObservations({ inputCapable: true,
      main: document({ childFrames: [{ index: 0, x: 0, y: 0, width: 400, height: 300, visible: true },
        { index: 1, x: 400, y: 0, width: 300, height: 300, visible: true }] }),
      frames: [frame([0], 'https://platform.linkedin.com', { childFrames: [{ index: 0, x: 0, y: 0, width: 100, height: 100, visible: true }] }),
        frame([0, 0], 'https://nested.example'), frame([1], 'https://widget.example')] }, ['linkedin.com']))
    expect(merged.frames?.map(entry => entry.origin)).toEqual(['https://widget.example'])
    expect(merged.text).not.toContain('linkedin')
    expect(merged.text).not.toContain('nested.example')
    expect(merged.elements.map(element => element.name)).toEqual(['Main button', 'Book 1'])
  })

  it('leaves out hidden or unplaced frames and keeps the shared caps', () => {
    const many = Array.from({ length: 120 }, (_, index) => control(`e${index}`, `Item ${index}`, { x: 5, y: 5 }))
    const merged = observationSchema.parse(mergeFrameObservations({ inputCapable: false,
      main: document({ text: 'x'.repeat(11990), childFrames: [
        { index: 0, x: 0, y: 0, width: 100, height: 100, visible: false },
        { index: 1, x: 0, y: 0, width: 100, height: 100, visible: true }] }),
      frames: [frame([0], 'https://hidden.example'), frame([1], 'https://busy.example', { elements: many }), frame([2], 'https://unplaced.example')] }))
    expect(merged.trustedInput).toBe(false)
    expect(merged.elements).toHaveLength(100)
    expect(merged.frames?.map(entry => entry.origin)).toEqual(['https://busy.example'])
    expect(merged.text.length).toBeLessThanOrEqual(12000)
    expect(merged.textTruncated).toBe(true)
  })

  it('caps a long frame URL so one ad frame cannot invalidate the observation', () => {
    const long = 'https://ads.example/' + 'q'.repeat(5000)
    const merged = observationSchema.parse(mergeFrameObservations({ inputCapable: true,
      main: document({ childFrames: [{ index: 0, x: 0, y: 0, width: 300, height: 250, visible: true }] }),
      frames: [frame([0], 'https://ads.example', { url: long })] }))
    expect(merged.frames?.[0].url).toHaveLength(2000)
  })

  it('ignores per-frame read counters when deciding whether the page changed', async () => {
    const { browserObservationState } = await import('../task-contract')
    const read = (frameObservationId: number) => observationSchema.parse(mergeFrameObservations({ inputCapable: true,
      main: document({ childFrames: [{ index: 0, x: 0, y: 0, width: 300, height: 250, visible: true }] }),
      frames: [frame([0], 'https://widget.example', { observationId: frameObservationId })] }))
    expect(browserObservationState(read(7))).toBe(browserObservationState(read(8)))
  })
})

