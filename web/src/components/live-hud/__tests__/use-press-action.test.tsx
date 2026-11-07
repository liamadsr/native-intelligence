// @vitest-environment jsdom
/**
 * The HUD's controls act on the mouse press (use-press-action.ts; Liam, 10-20:
 * the first click on the HUD from the call app did nothing). Pinned on the
 * real recording controls: a left mouse press acts at once and its click
 * doesn't act again; a press whose click never comes has still acted; a
 * keyboard click and a touch tap each act once; a disabled control doesn't.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { HudRecordingControls } from '../hud-recording-controls'
import type { HudRecordingActionType, HudRecordingState } from '@/lib/live-agent/hud-recording'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REC: HudRecordingState = { captureId: 'cap-1', paused: false, finalizing: false, transcription: 'connected', elapsedSec: 10, at: 1_000_000 }

let container: HTMLDivElement
let root: Root
let onAction: ReturnType<typeof vi.fn<(type: HudRecordingActionType) => void>>
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onAction = vi.fn<(type: HudRecordingActionType) => void>()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (state: HudRecordingState = REC) => act(() => root.render(h(HudRecordingControls, { state, onAction })))
const button = (label: string) => container.querySelector(`button[aria-label^="${label}"]`) as HTMLButtonElement
const press = (el: HTMLElement, pointerType = 'mouse', button = 0) =>
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType, button }))
  })
const click = (el: HTMLElement, detail = 1) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }))
  })
const key = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
  })

describe('the HUD controls act on the mouse press', () => {
  it('a mouse press acts at once, and its click does not act again', () => {
    render()
    press(button('Pause recording'))
    expect(onAction.mock.calls).toEqual([['pause']])
    click(button('Pause recording'))
    expect(onAction.mock.calls).toEqual([['pause']])
  })

  it('a press whose click never comes has still acted; the next press acts again', () => {
    render()
    press(button('Stop recording'))
    // The release is lost (the window coming forward): no click.
    press(button('Stop recording'))
    click(button('Stop recording'))
    expect(onAction.mock.calls).toEqual([['stop'], ['stop']])
  })

  it('every control does: back to the capture, pause or resume, stop', () => {
    render()
    press(button('Recording'))
    press(button('Pause recording'))
    press(button('Stop recording'))
    render({ ...REC, paused: true })
    press(button('Resume recording'))
    expect(onAction.mock.calls).toEqual([['open'], ['pause'], ['stop'], ['resume']])
  })

  it('a keyboard click acts once, also after a mouse press whose click was lost', () => {
    render()
    click(button('Pause recording'), 0)
    expect(onAction.mock.calls).toEqual([['pause']])
    press(button('Stop recording'))
    key(button('Stop recording'))
    click(button('Stop recording'), 0)
    expect(onAction.mock.calls).toEqual([['pause'], ['stop'], ['stop']])
  })

  it('a touch tap and a right or middle press act on the click, not the press', () => {
    render()
    press(button('Pause recording'), 'touch')
    expect(onAction).not.toHaveBeenCalled()
    click(button('Pause recording'))
    expect(onAction.mock.calls).toEqual([['pause']])
    press(button('Stop recording'), 'mouse', 2)
    expect(onAction.mock.calls).toEqual([['pause']])
  })

  it('a disabled control does nothing on a press (finishing up)', () => {
    render({ ...REC, finalizing: true })
    press(button('Pause recording'))
    press(button('Stop recording'))
    expect(onAction).not.toHaveBeenCalled()
  })
})
