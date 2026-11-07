// @vitest-environment jsdom
/**
 * PromotePackageDialog's "top 50 of N by confidence" line.
 *
 * N used to be `frozenClaimIds.length`, which is right only when the caller
 * holds every match. The map path does not: the server ranks the filtered set
 * and hands back the top 50 ids plus a separate `promote.total`, so deriving N
 * from the id list would always say "50" and the overflow sentence would never
 * appear at all — the one case it exists for.
 *
 * `frozenTotal` carries that real count for COPY only. The pins still come from
 * `frozenClaimIds`, because padding the id list to make N come out right would
 * corrupt what the dialog actually sends.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('../review-queue-dialog', () => ({
  ReviewQueueDialog: ({ children }: { children?: React.ReactNode }) => h('div', null, children),
}))
vi.mock('@/components/ui/markdown', () => ({ Markdown: () => h('div', null, 'md') }))
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@/lib/download', () => ({ downloadFile: vi.fn(async () => 'x') }))

import { PromotePackageDialog } from '../knowledge-library'

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
  vi.clearAllMocks()
})

function ids(n: number): string[] {
  return Array.from({ length: n }, (_u, i) => `claim-${i}`)
}

/** Radix portals the dialog content, so read the whole document. */
function copy(): string {
  return document.body.textContent ?? ''
}

function render(props: { frozenClaimIds: string[]; frozenTotal?: number }) {
  act(() => {
    root.render(
      h(PromotePackageDialog, {
        open: true,
        onOpenChange: () => {},
        defaultName: 'Filtered knowledge',
        // Both modes must be available or the frozen option is not rendered.
        liveRules: { types: ['fact'] },
        onCreated: () => {},
        ...props,
      }),
    )
  })
}

describe('PromotePackageDialog — frozenTotal', () => {
  it('counts the real match total when the caller holds only the top 50', () => {
    // The map path: 50 ids in hand, 1,240 matches behind them.
    render({ frozenClaimIds: ids(50), frozenTotal: 1240 })
    expect(copy()).toContain('top 50 of 1240 by confidence')
    // The pin count is still what we actually hold.
    expect(copy()).toContain('Pin the 50 current matches')
  })

  it('falls back to the id count when no total is given (Library + legacy)', () => {
    render({ frozenClaimIds: ids(80) })
    expect(copy()).toContain('top 50 of 80 by confidence')
  })

  it('shows no overflow line when the whole set fits under the cap', () => {
    render({ frozenClaimIds: ids(12), frozenTotal: 12 })
    expect(copy()).toContain('Pin the 12 current matches')
    expect(copy()).not.toContain('by confidence')
  })

  it('does not claim FEWER matches than the pins it is about to send', () => {
    // A stale/short total must never undercount the ids in hand.
    render({ frozenClaimIds: ids(80), frozenTotal: 3 })
    expect(copy()).toContain('top 50 of 80 by confidence')
  })

  it('is the ONLY thing frozenTotal changes — 50 ids still means 50 pins', () => {
    render({ frozenClaimIds: ids(50), frozenTotal: 100_000 })
    expect(copy()).toContain('Pin the 50 current matches')
    expect(copy()).toContain('top 50 of 100000 by confidence')
  })
})
