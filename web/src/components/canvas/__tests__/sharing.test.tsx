// @vitest-environment jsdom
/**
 * A canvas's sharing in its header (docs/plans/record-sharing.md, Phase 3):
 * the ⋯ menu offers Share to its owner once the app shares canvases (held
 * until the owner decides; GRANTING_HELD_TYPES), and a chip says it is shared,
 * with how many (to its owner) or with you (to someone it was shared with).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../surface', () => ({ CanvasSurface: () => null, isTyping: () => false }))

import { SharingChip, canShareFromMenu } from '../canvas-editor'
import type { RecordSharing } from '@/lib/entity-access/store'

const sharing = (over: Partial<RecordSharing> = {}): RecordSharing => ({ can_share: true, held: false, grant_count: 0, shared_with_me: false, ...over })

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const chip = (s: RecordSharing | null) => {
  act(() => root.render(h(SharingChip, { sharing: s })))
  return container.querySelector('[data-canvas-sharing]')?.textContent?.trim() ?? null
}

describe('a canvas’s sharing in its header', () => {
  it('offers Share to whoever may share it, and only once canvases are not held', () => {
    expect(canShareFromMenu(sharing())).toBe(true)
    expect(canShareFromMenu(sharing({ held: true }))).toBe(false)
    expect(canShareFromMenu(sharing({ can_share: false }))).toBe(false)
    expect(canShareFromMenu(null)).toBe(false)
  })

  it('tells its owner how many it is shared with, and nothing while it is shared with no one', () => {
    expect(chip(sharing({ grant_count: 3 }))).toBe('Shared · 3')
    expect(chip(sharing())).toBeNull()
  })

  it('tells someone it was shared with that it was', () => {
    expect(chip(sharing({ can_share: false, shared_with_me: true }))).toBe('Shared with you')
    expect(chip(sharing({ can_share: false }))).toBeNull()
    expect(chip(null)).toBeNull()
  })
})
