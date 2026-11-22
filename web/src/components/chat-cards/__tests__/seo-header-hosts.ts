/**
 * For the SEO page-card tests that draw the page in a card: the card header's
 * hosts as show-tool-card.tsx hands them to the page (its right end and the
 * trail after its title), and the title's press while a trail shows.
 */
import * as React from 'react'
import { vi } from 'vitest'
import { CardHeaderSlotsProvider, type CardHeaderBack } from '../card-header-slot'

export function seoHeaderHosts() {
  const right = document.createElement('div')
  right.dataset.testHeader = 'right'
  const trail = document.createElement('div')
  trail.dataset.testHeader = 'trail'
  document.body.append(right, trail)
  const setBack = vi.fn<(back: CardHeaderBack | null) => void>()
  return {
    right,
    trail,
    setBack,
    /** What the card's title does now: the last way back the page set, or null. */
    back: (): CardHeaderBack | null => setBack.mock.calls.at(-1)?.[0] ?? null,
    /** `node` inside the card header's slots. */
    wrap: (node: React.ReactNode) => React.createElement(CardHeaderSlotsProvider, { value: { left: null, right, trail, setBack } }, node),
    remove: () => {
      right.remove()
      trail.remove()
    },
  }
}
