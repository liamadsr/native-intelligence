// @vitest-environment jsdom
/**
 * The card waiting as the chat's Reply chip (card-reply-focus.ts): the column's
 * card it names reads true, every other card false, and only the cards whose
 * answer changed re-render.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CARD_REPLY_FOCUS_ATTR, dismissReplyingCard, setReplyingCard, useIsReplyingCard, useReplyFocus } from '../card-reply-focus'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rendered = vi.fn<(id: string) => void>()
const renders = (id: string) => rendered.mock.calls.filter(([c]) => c === id).length
function Card({ id }: { id: string }) {
  rendered(id)
  const on = useIsReplyingCard({ kind: 'card', id })
  return h('span', { 'data-card': id, 'data-on': on ? '1' : '0' })
}

describe('useIsReplyingCard', () => {
  let root: Root | null = null
  afterEach(() => {
    act(() => setReplyingCard(null))
    act(() => root?.unmount())
    root = null
  })

  it('names one card at a time; the others don’t re-render', () => {
    const el = document.createElement('div')
    root = createRoot(el)
    act(() => root!.render(h('div', null, h(Card, { id: 'a' }), h(Card, { id: 'b' }), h(Card, { id: 'c' }))))
    const on = () => [...el.querySelectorAll('[data-card]')].map((n) => n.getAttribute('data-on')).join('')
    expect(on()).toBe('000')
    const before = { a: renders('a'), c: renders('c') }
    act(() => setReplyingCard({ kind: 'card', id: 'b' }))
    expect(on()).toBe('010')
    expect(renders('a')).toBe(before.a)
    expect(renders('c')).toBe(before.c)
    act(() => setReplyingCard({ kind: 'review', id: 'b' }))
    expect(on()).toBe('000')
    act(() => setReplyingCard({ kind: 'card', id: 'c' }))
    expect(on()).toBe('001')
    act(() => setReplyingCard(null))
    expect(on()).toBe('000')
  })

  it('says whether any card waits, and takes the chip off through the panel’s dismiss', () => {
    const el = document.createElement('div')
    root = createRoot(el)
    const focus = vi.fn<(on: boolean) => void>()
    function Probe() {
      focus(useReplyFocus())
      return null
    }
    act(() => root!.render(h(Probe)))
    expect(focus).toHaveBeenLastCalledWith(false)
    const off = vi.fn()
    act(() => setReplyingCard({ kind: 'card', id: 'a' }, off))
    expect(focus).toHaveBeenLastCalledWith(true)
    expect(document.documentElement.hasAttribute(CARD_REPLY_FOCUS_ATTR)).toBe(true)
    dismissReplyingCard()
    expect(off).toHaveBeenCalledTimes(1)
    act(() => setReplyingCard(null))
    expect(focus).toHaveBeenLastCalledWith(false)
    expect(document.documentElement.hasAttribute(CARD_REPLY_FOCUS_ATTR)).toBe(false)
    dismissReplyingCard()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
