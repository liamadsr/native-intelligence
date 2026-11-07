// @vitest-environment jsdom
/**
 * QuestionPopover's `hidden` (chat/question-popover.tsx), set while its chat
 * tab is inactive. The popout portals to <body>, out of the hidden tab, so it
 * has to hide itself.
 *
 * Contract pinned here:
 *  - Hidden, the content is display:none, inert and aria-hidden. Radix places
 *    the content inside its own `[data-radix-popper-content-wrapper]` div,
 *    which the content's className never reaches: with the old
 *    `invisible pointer-events-none` that wrapper kept the panel's full rect
 *    and caught the active tab's clicks (an Edit on a held-message row landed
 *    on it). A display:none child collapses the wrapper to 0×0.
 *  - It stays mounted while hidden: a half-typed answer is still there when
 *    the tab comes back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { AgentQuestion } from '@/lib/chat/eve/agent-question'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// The real one pulls in the whole composer (chat-input) for a width measure.
vi.mock('../picker-popover', () => ({
  measureChatReadingColumn: (w: number) => Math.min(w, 640),
}))

import { QuestionPopover } from '../question-popover'

const question = {
  toolCallId: 'call-1',
  questions: [
    {
      question: 'Which day works for the call?',
      header: 'Call day',
      options: [{ label: 'Monday' }, { label: 'Tuesday' }],
      multiSelect: false,
    },
  ] as AgentQuestion[],
}

let root: Root
let container: HTMLDivElement
let anchor: HTMLDivElement

function render(hidden: boolean) {
  act(() => {
    root.render(
      h(QuestionPopover, {
        question,
        anchorRef: { current: anchor },
        onAnswer: () => {},
        onSkip: () => {},
        onClose: () => {},
        hidden,
      }),
    )
  })
}

function wrapper() {
  return document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')
}

function content() {
  return wrapper()!.firstElementChild as HTMLElement
}

function otherInput() {
  return document.querySelector<HTMLInputElement>('input[placeholder="Type your own answer"]')!
}

beforeEach(() => {
  anchor = document.createElement('div')
  container = document.createElement('div')
  document.body.append(anchor, container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('QuestionPopover hidden', () => {
  it('shows the open question normally', () => {
    render(false)
    expect(wrapper()).not.toBeNull()
    expect(getComputedStyle(content()).display).not.toBe('none')
    expect(content().hasAttribute('inert')).toBe(false)
    expect(content().getAttribute('aria-hidden')).toBeNull()
    expect(content().textContent).toContain('Which day works for the call?')
  })

  it('takes the content out of layout and makes it inert, so its wrapper catches no clicks', () => {
    render(true)
    // Still mounted under its wrapper, not unmounted.
    expect(wrapper()).not.toBeNull()
    expect(content().textContent).toContain('Which day works for the call?')
    // Out of layout: the wrapper's only child is display:none, so the wrapper
    // has no box to hit-test.
    expect(wrapper()!.children).toHaveLength(1)
    expect(getComputedStyle(content()).display).toBe('none')
    expect(content().hasAttribute('inert')).toBe(true)
    expect(content().getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps a half-typed answer across hide and show', () => {
    render(false)
    const input = otherInput()
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Thursday after 3')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(otherInput().value).toBe('Thursday after 3')

    render(true)
    expect(getComputedStyle(content()).display).toBe('none')

    render(false)
    expect(otherInput()).toBe(input)
    expect(otherInput().value).toBe('Thursday after 3')
    expect(getComputedStyle(content()).display).not.toBe('none')
    expect(content().hasAttribute('inert')).toBe(false)
  })
})
