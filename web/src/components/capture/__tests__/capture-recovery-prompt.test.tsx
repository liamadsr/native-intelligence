// @vitest-environment jsdom
/**
 * CaptureRecoveryPrompt — "Resume interrupted capture?" on launch.
 *
 * Radix's AlertDialog focuses Cancel when it opens, and Cancel here is End
 * capture: one Enter or Space and an interrupted meeting was closed (the
 * 2026-10-19 Owen call split in two that way after a mid-call restart). Pinned:
 * Resume recording holds the focus, Enter on it resumes, and End capture still
 * takes a deliberate click.
 *
 * The real Radix dialog renders here (focus handling is the thing under test);
 * only the recording context is faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const recording = {
  pendingRecovery: { captureId: 'cap-1', title: 'Owen & Liam' } as { captureId: string; title: string } | null,
  confirmRecovery: vi.fn(async () => {}),
  dismissRecovery: vi.fn(async () => {}),
}
vi.mock('@/hooks/recording-context', () => ({
  useOptionalRecordingStable: () => recording,
}))

import { CaptureRecoveryPrompt } from '../capture-recovery-prompt'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  recording.pendingRecovery = { captureId: 'cap-1', title: 'Owen & Liam' }
  recording.confirmRecovery.mockClear()
  recording.dismissRecovery.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!found) throw new Error(`no "${label}" button`)
  return found as HTMLButtonElement
}

describe('CaptureRecoveryPrompt', () => {
  it('opens with Resume recording focused, not End capture', async () => {
    await act(async () => { root.render(h(CaptureRecoveryPrompt)) })
    await vi.waitFor(() => expect(document.activeElement).toBe(button('Resume recording')))
    expect(document.activeElement).not.toBe(button('End capture'))
  })

  it('resumes on the focused button and ends only on a click of End capture', async () => {
    await act(async () => { root.render(h(CaptureRecoveryPrompt)) })
    await vi.waitFor(() => expect(document.activeElement).toBe(button('Resume recording')))
    // Enter on a focused button activates it: a click event on that button.
    await act(async () => { (document.activeElement as HTMLButtonElement).click() })
    expect(recording.confirmRecovery).toHaveBeenCalledTimes(1)
    expect(recording.dismissRecovery).not.toHaveBeenCalled()
  })

  it('still ends the capture when End capture is clicked', async () => {
    await act(async () => { root.render(h(CaptureRecoveryPrompt)) })
    await act(async () => { button('End capture').click() })
    expect(recording.dismissRecovery).toHaveBeenCalledTimes(1)
    expect(recording.confirmRecovery).not.toHaveBeenCalled()
  })

  it('renders nothing with no interrupted capture', async () => {
    recording.pendingRecovery = null
    await act(async () => { root.render(h(CaptureRecoveryPrompt)) })
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })
})
