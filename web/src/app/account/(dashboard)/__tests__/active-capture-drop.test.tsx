// @vitest-environment jsdom
/**
 * During a live capture, files dropped anywhere in the app outside a drop
 * zone attach to the capture being recorded; the chat box (and a capture's,
 * action's or project's panel) keeps its own drops. With no live capture a
 * drop outside a zone does nothing, and never navigates to the file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const recording = vi.hoisted(() => ({
  current: null as null | { isRecording: boolean; isStarting: boolean; captureId: string | null },
}))
const uploadAttachments = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ loading: vi.fn(() => 't1'), success: vi.fn(), error: vi.fn() }))
const onChanged = vi.hoisted(() => vi.fn((_cb: (id: string) => void) => () => {}))

vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => recording.current }))
vi.mock('@/lib/attachments/upload-client', () => ({ uploadAttachments }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/tauri-bridge', () => ({ tauriBridge: { captureAttachments: { onChanged } } }))

import { ActiveCaptureDrop } from '../active-capture-drop'
import { CAPTURE_ATTACHMENTS_EVENT } from '@/lib/attachments/dropped-files'

function fire(target: EventTarget, type: string, files: File[]): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files, items: [], dropEffect: 'none' } })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

const flush = () => act(async () => {})

let container: HTMLDivElement
let root: Root
let page: HTMLDivElement
let composer: HTMLDivElement
const shot = new File(['x'], 'shot.png', { type: 'image/png' })

beforeEach(() => {
  recording.current = { isRecording: true, isStarting: false, captureId: 'cap-live' }
  uploadAttachments.mockReset().mockResolvedValue({ uploaded: 1, firstError: null })
  toast.loading.mockClear()
  toast.success.mockClear()
  toast.error.mockClear()
  // The app's page: some content, and a chat box that keeps its drops (as
  // chat-input.tsx: preventDefault + stopPropagation).
  page = document.createElement('div')
  page.innerHTML = '<p data-content>calendar</p><div data-file-drop-zone data-composer><textarea></textarea></div>'
  composer = page.querySelector('[data-composer]')!
  composer.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  composer.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  document.body.appendChild(page)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(h(ActiveCaptureDrop)))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  page.remove()
})

describe('ActiveCaptureDrop', () => {
  it('attaches files dropped outside a zone to the live capture, and tells its panels', async () => {
    const heard = vi.fn()
    window.addEventListener(CAPTURE_ATTACHMENTS_EVENT, heard)
    const e = fire(page.querySelector('[data-content]')!, 'drop', [shot])
    await flush()
    expect(e.defaultPrevented).toBe(true)
    expect(uploadAttachments).toHaveBeenCalledWith([shot], { noteId: 'cap-live' })
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({ captureId: 'cap-live' })
    expect(toast.success).toHaveBeenCalledWith('Attached shot.png to the live capture', { id: 't1' })
    window.removeEventListener(CAPTURE_ATTACHMENTS_EVENT, heard)
  })

  it('leaves a drop on the chat box to the chat', async () => {
    fire(composer.querySelector('textarea')!, 'drop', [shot])
    await flush()
    expect(uploadAttachments).not.toHaveBeenCalled()
  })

  it("leaves a drop a zone took without stopping it (the project panel's) to that zone", async () => {
    const zone = document.createElement('div')
    zone.setAttribute('data-file-drop-zone', '')
    zone.addEventListener('drop', (e) => e.preventDefault())
    page.appendChild(zone)
    fire(zone, 'drop', [shot])
    await flush()
    expect(uploadAttachments).not.toHaveBeenCalled()
  })

  it("never navigates off a zone that stops the drag without taking it (the environment dialog's)", async () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('data-file-drop-zone', '')
    for (const type of ['dragover', 'drop']) dialog.addEventListener(type, (e) => e.stopPropagation())
    page.appendChild(dialog)
    const over = fire(dialog, 'dragover', [shot])
    const drop = fire(dialog, 'drop', [shot])
    await flush()
    expect(over.defaultPrevented).toBe(true)
    expect(drop.defaultPrevented).toBe(true)
    expect(uploadAttachments).not.toHaveBeenCalled()
  })

  it('with no live capture, a drop attaches nowhere and never navigates', async () => {
    recording.current = { isRecording: false, isStarting: false, captureId: null }
    act(() => root.render(h(ActiveCaptureDrop)))
    const over = fire(page.querySelector('[data-content]')!, 'dragover', [shot])
    const drop = fire(page.querySelector('[data-content]')!, 'drop', [shot])
    await flush()
    expect(over.defaultPrevented).toBe(true)
    expect(drop.defaultPrevented).toBe(true)
    expect(uploadAttachments).not.toHaveBeenCalled()
  })

  it('counts a capture that is starting as live', async () => {
    recording.current = { isRecording: false, isStarting: true, captureId: 'cap-new' }
    act(() => root.render(h(ActiveCaptureDrop)))
    fire(page.querySelector('[data-content]')!, 'drop', [shot])
    await flush()
    expect(uploadAttachments).toHaveBeenCalledWith([shot], { noteId: 'cap-new' })
  })

  it('says where files will go while they are over the app, and not over a zone', () => {
    const content = page.querySelector('[data-content]')!
    fire(content, 'dragenter', [shot])
    expect(document.querySelector('[data-active-capture-drop]')?.textContent).toBe('Drop to attach to the live capture')
    fire(composer, 'dragover', [shot])
    expect(document.querySelector('[data-active-capture-drop]')).toBeNull()
    fire(content, 'dragover', [shot])
    expect(document.querySelector('[data-active-capture-drop]')).not.toBeNull()
    fire(content, 'drop', [shot])
    expect(document.querySelector('[data-active-capture-drop]')).toBeNull()
  })

  it('hides the hint when the files leave the window', () => {
    const content = page.querySelector('[data-content]')!
    const p = document.createElement('span')
    content.appendChild(p)
    // Into the content, on into a child of it (enter before leave), then out.
    fire(content, 'dragenter', [shot])
    fire(p, 'dragenter', [shot])
    fire(content, 'dragleave', [shot])
    expect(document.querySelector('[data-active-capture-drop]')).not.toBeNull()
    fire(p, 'dragleave', [shot])
    expect(document.querySelector('[data-active-capture-drop]')).toBeNull()
  })

  it('reports a failed upload', async () => {
    uploadAttachments.mockResolvedValue({ uploaded: 0, firstError: '.exe files aren\'t supported.' })
    fire(page.querySelector('[data-content]')!, 'drop', [shot])
    await flush()
    expect(toast.error).toHaveBeenCalledWith(".exe files aren't supported.", { id: 't1' })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("relays the desktop's word from another window to this window's panels", () => {
    const relay = onChanged.mock.calls.at(-1)![0]
    const heard = vi.fn()
    window.addEventListener(CAPTURE_ATTACHMENTS_EVENT, heard)
    relay('cap-hud')
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({ captureId: 'cap-hud' })
    window.removeEventListener(CAPTURE_ATTACHMENTS_EVENT, heard)
  })
})
