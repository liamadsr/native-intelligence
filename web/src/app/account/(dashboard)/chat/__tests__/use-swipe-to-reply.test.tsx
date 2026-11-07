// @vitest-environment jsdom
/**
 * Swipe a message to the right to reply (use-swipe-to-reply.ts). Pinned:
 *   • the message follows 1:1 up to the threshold, then with give, to a max;
 *   • a trackpad's sideways swipe on a bubble of an agent message, let go
 *     past the threshold, replies once to that bubble (natural scrolling:
 *     fingers right are a negative deltaX); short of it, nothing; either way
 *     the bubble goes back and the arrow goes;
 *   • only the bubble moves (with its reaction, and the toolbar when it is on
 *     it), never the tool steps beside it; the arrow sits beside the bubble,
 *     at its middle;
 *   • the person's own messages, a tool step, a mostly vertical scroll, and a
 *     swipe that starts in something that scrolls sideways itself are never
 *     a reply.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { SWIPE_REPLY_PX, swipeOffset, useSwipeToReply } from '../use-swipe-to-reply'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('swipeOffset', () => {
  it('is 1:1 up to the threshold, then gives, up to its max', () => {
    expect(swipeOffset(-5)).toBe(0)
    expect(swipeOffset(30)).toBe(30)
    expect(swipeOffset(SWIPE_REPLY_PX)).toBe(SWIPE_REPLY_PX)
    expect(swipeOffset(SWIPE_REPLY_PX + 20)).toBeCloseTo(SWIPE_REPLY_PX + 7)
    expect(swipeOffset(1000)).toBe(84)
  })
})

describe('useSwipeToReply', () => {
  let container: HTMLDivElement
  let root: Root
  let thread: HTMLDivElement
  const onReply = vi.fn()

  function Host({ el }: { el: HTMLElement }) {
    useSwipeToReply(el, onReply, true)
    return null
  }
  const row = (id: string, role: string) => {
    const r = document.createElement('div')
    r.dataset.messageRow = id
    r.dataset.messageRole = role
    const bubble = document.createElement('div')
    bubble.className = 'chat-message-bubble'
    bubble.textContent = 'words'
    r.append(bubble)
    thread.append(r)
    return r
  }
  const swipe = (target: Element, deltaX: number, times: number, deltaY = 0) => {
    for (let i = 0; i < times; i++) target.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY, bubbles: true }))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    onReply.mockReset()
    container = document.createElement('div')
    thread = document.createElement('div')
    document.body.append(container, thread)
    root = createRoot(container)
    act(() => root.render(h(Host, { el: thread })))
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    thread.remove()
    vi.useRealTimers()
  })

  it('a swipe past the threshold on a bubble replies once to it; only the bubble moves, and goes back; the arrow goes', () => {
    const r = row('a1', 'assistant')
    const step = document.createElement('div')
    step.textContent = 'List actions · Done'
    r.prepend(step)
    const bubble = r.querySelector<HTMLElement>('.chat-message-bubble')!
    swipe(bubble, -10, 8)
    expect(bubble.style.transform).toMatch(/^translateX\(/)
    expect(step.style.transform).toBe('')
    expect(r.style.transform).toBe('')
    expect(r.querySelector('[data-swipe-reply-arrow]')).not.toBeNull()
    vi.advanceTimersByTime(200)
    expect(onReply).toHaveBeenCalledTimes(1)
    expect(onReply).toHaveBeenCalledWith(r, bubble)
    expect(bubble.style.transform).toBe('')
    expect(r.querySelector('[data-swipe-reply-arrow]')).toBeNull()
  })

  it('its reaction rides with it', () => {
    const r = row('a1', 'assistant')
    const bubble = r.querySelector<HTMLElement>('.chat-message-bubble')!
    const badge = document.createElement('button')
    badge.setAttribute('data-message-reaction', '👍')
    bubble.after(badge)
    swipe(bubble, -10, 4)
    expect(badge.style.transform).toBe(bubble.style.transform)
    vi.advanceTimersByTime(200)
  })

  it('the toolbar on this bubble rides with it, keeping its own place, and goes back to it', () => {
    const r = row('a1', 'assistant')
    const bubble = r.querySelector<HTMLElement>('.chat-message-bubble')!
    const bar = document.createElement('div')
    bar.setAttribute('data-message-toolbar', '')
    bar.dataset.bubble = '0'
    bar.style.transform = 'translateX(-100%)'
    r.append(bar)
    swipe(bubble, -10, 4)
    expect(bar.style.transform).toBe('translateX(-100%) translateX(40px)')
    vi.advanceTimersByTime(200)
    expect(bar.style.transform).toBe('translateX(-100%)')
    // On another bubble, it stays.
    bar.dataset.bubble = '1'
    swipe(bubble, -10, 4)
    expect(bar.style.transform).toBe('translateX(-100%)')
    vi.advanceTimersByTime(200)
  })

  it('short of the threshold, nothing; on a tool step, nothing moves', () => {
    const r = row('a1', 'assistant')
    const bubble = r.querySelector<HTMLElement>('.chat-message-bubble')!
    swipe(bubble, -10, 3)
    vi.advanceTimersByTime(200)
    expect(onReply).not.toHaveBeenCalled()
    expect(bubble.style.transform).toBe('')
    const step = document.createElement('div')
    r.prepend(step)
    swipe(step, -10, 8)
    expect(r.querySelector('[data-swipe-reply-arrow]')).toBeNull()
    vi.advanceTimersByTime(600)
    expect(onReply).not.toHaveBeenCalled()
  })

  it('never the person’s own message, a vertical scroll, or something that scrolls sideways itself', () => {
    swipe(row('u1', 'user').firstElementChild!, -10, 8)
    vi.advanceTimersByTime(600)
    swipe(row('a1', 'assistant').firstElementChild!, -2, 8, 30)
    vi.advanceTimersByTime(600)
    const a2 = row('a2', 'assistant')
    const code = document.createElement('pre')
    code.style.overflowX = 'auto'
    Object.defineProperty(code, 'scrollWidth', { value: 900 })
    Object.defineProperty(code, 'clientWidth', { value: 300 })
    a2.querySelector('.chat-message-bubble')!.append(code)
    swipe(code, -10, 8)
    vi.advanceTimersByTime(600)
    expect(onReply).not.toHaveBeenCalled()
  })
})
