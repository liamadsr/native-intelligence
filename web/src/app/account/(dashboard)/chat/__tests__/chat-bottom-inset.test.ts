/**
 * The main chat keeps to its latest message (Liam, 11-20: "sometimes … when
 * I switch between pages or when I go back to the app … the main chat
 * history is all the way to the top"): the room the thread keeps clear for
 * the composer floating over it is an element, the thread's last child,
 * never the thread's padding.
 *
 * Why: use-stick-to-bottom follows the thread through a ResizeObserver on it,
 * which reads its content box and never its padding. As padding, the room
 * changed unseen whenever the composer's height did (a page opening over the
 * chat took it from 88px to 8px): the scroll position clamped up, the library
 * read that as the person scrolling up and stopped following, and the next
 * reload of the thread left it at the top. As an element, the same change is
 * a resize the library sees and follows. (A browser check measured it: after
 * a page opened and closed, the chat 80px off its bottom before, at its bottom
 * after; a message arriving meanwhile followed too.)
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'src/app/account/(dashboard)/chat/chat-panel.tsx'), 'utf8')

describe('the main chat’s room for the composer', () => {
  it('is the thread’s last child, as tall as the composer’s dock (and its breath), the list’s gap taken back', () => {
    const spacer = '<div aria-hidden data-chat-bottom-inset="" className="-mt-4 h-[calc(var(--chat-bottom-inset,0px)+0.5rem)] shrink-0" />'
    expect(source).toContain(spacer)
    // Right before the thread closes: nothing after it in the list.
    expect(source.slice(source.indexOf(spacer) + spacer.length).trimStart().startsWith('</ChatContainerContent>')).toBe(true)
  })

  it('is never the thread’s padding, which the stick-to-bottom observer can’t see', () => {
    expect(source).not.toMatch(/pb-\[calc\(var\(--chat-bottom-inset/)
  })
})
