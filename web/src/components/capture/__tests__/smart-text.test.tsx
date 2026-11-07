// @vitest-environment jsdom
/**
 * SmartText's date chip stands on its own: a suggestion card renders in a
 * document card, the chat or a capture, and none promises a TooltipProvider
 * above it. A bare Radix Tooltip throws without one, and the dashboard's error
 * boundary then blanks the whole app (10-24: opening a weekly-groom brief from
 * For you, its suggestions re-dating actions).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SmartText } from '../smart-text'
import type { ProposedChange } from '@/lib/proposed-changes/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function change(over: Partial<ProposedChange> = {}): ProposedChange {
  return {
    id: 'c1',
    change_type: 'update',
    entity_type: 'action',
    display_text: 'Move ENG-42 to Oct 28',
    due_date: '2026-10-28',
    ...over,
  } as ProposedChange
}

describe('SmartText', () => {
  it('renders a date chip with no TooltipProvider above it', async () => {
    await act(async () => root.render(h(SmartText, { change: change() })))
    expect(container.textContent).toBe('Move ENG-42 to Oct 28')
    const chip = [...container.querySelectorAll('span')].find((s) => s.textContent === 'Oct 28')
    expect(chip?.className).toContain('text-amber-400')
  })
})
