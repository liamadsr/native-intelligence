// @vitest-environment jsdom
/**
 * The shell's blur while a card waits as the chat's Reply chip
 * (CardReplyBackdrop): nothing until then; then the For you focus view's own
 * blur, over the top bar (z-[45], under the lifted composer and column), a
 * hole blocker for the in-app browser, the sky held still; a press on it
 * takes the chip off. The content row, the chat strip, the composer dock and
 * the column switch stacking off the <html> attribute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CardReplyBackdrop, REPLY_SKY_HOLD } from '../card-reply-chip'
import { FOCUS_BACKDROP_CLASS } from '@/components/attention/column-focus-view'
import { setReplyingCard } from '@/lib/chat/card-reply-focus'
import { skyActivity } from '@/lib/sky/sky-activity'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('CardReplyBackdrop', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(h(CardReplyBackdrop)))
  })
  afterEach(() => {
    act(() => setReplyingCard(null))
    act(() => root.unmount())
    container.remove()
  })
  const backdrop = () => container.querySelector<HTMLElement>('[data-card-reply-backdrop]')

  it('the focus view’s blur over everything while a card waits; a press takes the chip off', () => {
    expect(backdrop()).toBeNull()
    const off = vi.fn()
    act(() => setReplyingCard({ kind: 'card', id: 'c1' }, off))
    const el = backdrop()!
    for (const c of FOCUS_BACKDROP_CLASS.split(' ')) expect(el.classList.contains(c)).toBe(true)
    expect(el.classList.contains('z-[45]')).toBe(true)
    expect(skyActivity.holds()).toContain(REPLY_SKY_HOLD)
    act(() => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(off).toHaveBeenCalledTimes(1)
    act(() => setReplyingCard(null))
    expect(backdrop()).toBeNull()
    expect(skyActivity.holds()).not.toContain(REPLY_SKY_HOLD)
  })

  it('what rises over it, and what stops stacking meanwhile, is keyed off <html>', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
    const shell = read('../../dashboard-shell.tsx')
    // The content row and the chat strip stop forming stacking contexts.
    expect(shell.match(/\[html\[data-card-reply-focus\]_&\]:z-auto/g)).toHaveLength(2)
    expect(shell).toContain('<CardReplyBackdrop />')
    // The composer dock and the For you column rise over the blur's z-[45].
    expect(read('../chat-panel.tsx')).toContain('data-chat-composer-dock="" className="absolute inset-x-0 bottom-0 z-20 [html[data-card-reply-focus]_&]:z-[46]"')
    expect(read('../for-you-column.tsx')).toContain('[html[data-card-reply-focus]_&]:z-[46]')
  })
})
