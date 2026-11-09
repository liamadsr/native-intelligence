// @vitest-environment jsdom
/**
 * The card in front (../front-card.ts): what the app rail lights and puts
 * away, and <html>'s FRONT_CARD_ATTR while one is held.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { FRONT_CARD_ATTR, closeFrontCards, frontCard, holdFrontCard, subscribeFrontCard } from '../front-card'

const mail: CardSpec = { kind: 'mail', title: 'Inbox', mail: { folder: 'inbox' } }
const chat: CardSpec = { kind: 'team_chat', title: 'Team chat' }

const releases: Array<() => void> = []
const hold = (id: string, spec: CardSpec, close = vi.fn()) => {
  const release = holdFrontCard({ id, spec, close })
  releases.push(release)
  return { release, close }
}
const attr = () => document.documentElement.hasAttribute(FRONT_CARD_ATTR)

afterEach(() => {
  while (releases.length) releases.pop()!()
})

describe('the card in front', () => {
  it('is none, and <html> unmarked, with nothing held', () => {
    expect(frontCard()).toBeNull()
    expect(attr()).toBe(false)
  })

  it('is the one held last, and <html> is marked while any is held', () => {
    const a = hold('a', mail)
    expect(frontCard()?.id).toBe('a')
    expect(attr()).toBe(true)
    const b = hold('b', chat)
    expect(frontCard()?.id).toBe('b')
    b.release()
    expect(frontCard()?.id).toBe('a')
    expect(attr()).toBe(true)
    a.release()
    expect(frontCard()).toBeNull()
    expect(attr()).toBe(false)
  })

  it('stays marked when one card is let go as the next is held (a switch)', () => {
    const a = hold('a', mail)
    const seen: boolean[] = []
    const off = subscribeFrontCard(() => seen.push(attr()))
    a.release()
    hold('b', chat)
    off()
    expect(frontCard()?.id).toBe('b')
    expect(attr()).toBe(true)
    // In between it is unmarked, but both happen before a paint (layout effects).
    expect(seen).toEqual([false, true])
  })

  it('tells its subscribers, and is the same object between changes', () => {
    const listener = vi.fn()
    const off = subscribeFrontCard(listener)
    hold('a', mail)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(frontCard()).toBe(frontCard())
    off()
    hold('b', chat)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('lets go once, however often the release runs', () => {
    const listener = vi.fn()
    const a = hold('a', mail)
    const off = subscribeFrontCard(listener)
    a.release()
    a.release()
    off()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('closeFrontCards puts every card back, the front one first', () => {
    const order: string[] = []
    hold('a', mail, vi.fn(() => order.push('a')))
    hold('b', chat, vi.fn(() => order.push('b')))
    closeFrontCards()
    expect(order).toEqual(['b', 'a'])
  })
})
