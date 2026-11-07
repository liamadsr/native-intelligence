// @vitest-environment jsdom
/**
 * Files dropped on the agent HUD's window attach to the call's capture,
 * uploaded from the HUD, and the app's windows hear that its attachments
 * changed. Before the HUD knows its call, a drop does nothing (and never
 * navigates the window to the file).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const uploadAttachments = vi.hoisted(() => vi.fn())
const announce = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/lib/attachments/upload-client', () => ({ uploadAttachments }))
vi.mock('@/lib/tauri-bridge', () => ({ tauriBridge: { captureAttachments: { announce } } }))
vi.mock('@/components/live-hud/agent-hud-view', () => ({ AgentHudView: () => null, HUD_WINDOW_CLIP: '' }))

import { HudFileDrop } from '../agent-hud'

function fire(type: string, files: File[]): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files, items: [], dropEffect: 'none' } })
  act(() => {
    document.body.dispatchEvent(e)
  })
  return e
}

let container: HTMLDivElement
let root: Root
const shot = new File(['x'], 'shot.png', { type: 'image/png' })

beforeEach(() => {
  uploadAttachments.mockReset().mockResolvedValue({ uploaded: 1, firstError: null })
  announce.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('HudFileDrop', () => {
  it("attaches a drop to the call's capture and tells the app's windows", async () => {
    act(() => root.render(h(HudFileDrop, { captureId: 'cap-call' })))
    fire('dragenter', [shot])
    expect(document.querySelector('[data-hud-file-drop]')?.textContent).toBe('Drop to attach to the capture')
    const e = fire('drop', [shot])
    expect(e.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-hud-file-drop]')).toBeNull()
    expect(document.querySelector('[data-hud-file-note="busy"]')?.textContent).toBe('Attaching shot.png…')
    await act(async () => {})
    expect(uploadAttachments).toHaveBeenCalledWith([shot], { noteId: 'cap-call' })
    expect(announce).toHaveBeenCalledWith('cap-call')
    expect(document.querySelector('[data-hud-file-note="done"]')?.textContent).toBe('Attached shot.png to the capture')
  })

  it('says why a drop was not attached', async () => {
    uploadAttachments.mockResolvedValue({ uploaded: 0, firstError: 'You need to be signed in to upload attachments.' })
    act(() => root.render(h(HudFileDrop, { captureId: 'cap-call' })))
    fire('drop', [shot])
    await act(async () => {})
    expect(announce).not.toHaveBeenCalled()
    expect(document.querySelector('[data-hud-file-note="error"]')?.textContent).toBe(
      'You need to be signed in to upload attachments.',
    )
  })

  it('before the HUD knows its call, a drop does nothing and never navigates', async () => {
    act(() => root.render(h(HudFileDrop, { captureId: null })))
    fire('dragenter', [shot])
    expect(document.querySelector('[data-hud-file-drop]')).toBeNull()
    const over = fire('dragover', [shot])
    const drop = fire('drop', [shot])
    await act(async () => {})
    expect(over.defaultPrevented).toBe(true)
    expect(drop.defaultPrevented).toBe(true)
    expect(uploadAttachments).not.toHaveBeenCalled()
  })

  it('follows the call: a drop after the capture changes goes to the new one', async () => {
    act(() => root.render(h(HudFileDrop, { captureId: 'cap-1' })))
    act(() => root.render(h(HudFileDrop, { captureId: 'cap-2' })))
    fire('drop', [shot])
    await act(async () => {})
    expect(uploadAttachments).toHaveBeenCalledWith([shot], { noteId: 'cap-2' })
  })
})
