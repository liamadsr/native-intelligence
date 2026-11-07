// @vitest-environment jsdom
/**
 * `CopyValueButton` — the hover copy affordance on every property/detail row.
 *
 * Pins the three behaviours the rows rely on:
 *  - An empty value renders NOTHING (no inert icon beside an empty input).
 *  - A click copies the raw value and flips to the "Copied" state, which is
 *    also what keeps the button visible after the pointer leaves the row.
 *  - A mousedown is swallowed, so clicking the button beside a focused input
 *    does not blur it (blur is what commits a PATCH on the property rows).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const copyTextToClipboard = vi.fn(async (_text: string) => true)
vi.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboard(text),
}))

import { CopyValueButton } from '../copy-value-button'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  copyTextToClipboard.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function button() {
  return container.querySelector('button')
}

describe('CopyValueButton', () => {
  it('renders nothing for an empty or whitespace value', () => {
    act(() => root.render(<CopyValueButton value="" />))
    expect(button()).toBeNull()
    act(() => root.render(<CopyValueButton value="   " />))
    expect(button()).toBeNull()
    act(() => root.render(<CopyValueButton value={null} />))
    expect(button()).toBeNull()
  })

  it('copies the raw value and shows the copied state for a moment', async () => {
    vi.useFakeTimers()
    act(() => root.render(<CopyValueButton value="  hello@acme.com " label="Email" />))
    const el = button()!
    expect(el.getAttribute('aria-label')).toBe('Copy email')
    expect(el.dataset.copied).toBeUndefined()

    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(copyTextToClipboard).toHaveBeenCalledWith('hello@acme.com')
    expect(el.dataset.copied).toBe('true')
    expect(el.getAttribute('aria-label')).toBe('Copied')

    await act(async () => {
      vi.advanceTimersByTime(1600)
    })
    expect(el.dataset.copied).toBeUndefined()
    expect(el.getAttribute('aria-label')).toBe('Copy email')
  })

  it('stays in the idle state when the clipboard write fails', async () => {
    copyTextToClipboard.mockResolvedValueOnce(false)
    act(() => root.render(<CopyValueButton value="x" />))
    await act(async () => {
      button()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(button()!.dataset.copied).toBeUndefined()
  })

  it('does not steal focus from a sibling input on mousedown', () => {
    act(() =>
      root.render(
        <div>
          <input defaultValue="v" />
          <CopyValueButton value="v" />
        </div>,
      ),
    )
    const input = container.querySelector('input')!
    input.focus()
    expect(document.activeElement).toBe(input)

    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button()!.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
  })

  it('stops the click from bubbling to a clickable parent row', async () => {
    const onRowClick = vi.fn()
    act(() =>
      root.render(
        <div onClick={onRowClick}>
          <CopyValueButton value="v" />
        </div>,
      ),
    )
    await act(async () => {
      button()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRowClick).not.toHaveBeenCalled()
    expect(copyTextToClipboard).toHaveBeenCalledWith('v')
  })
})
