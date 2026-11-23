// @vitest-environment jsdom
/**
 * A pull request's Description / Files changed / Checks in a card's header
 * (Liam, 11-23: "these details view pages like projects and pull request …
 * feel out of place"): a capsule in the card's right slot, the counts after
 * the words, a press switching what the page shows, and no row of pills over
 * the title. On its own, the row of pills, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/ui/markdown', () => ({ Markdown: ({ children }: { children: string }) => React.createElement('div', { 'data-md': '' }, children) }))

import { PullDetail } from '../pages/reviews/pull-detail'
import { CardHeaderSlotsProvider } from '../card-header-slot'
import { WindowPropertiesProvider } from '@/components/views/window-properties'
import type { ReviewPr } from '@/lib/github/reviews'

const PR: ReviewPr = {
  id: 'PR_7',
  repo: 'acme/app',
  number: 7,
  title: 'Change 7',
  url: 'https://github.com/acme/app/pull/7',
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  reviewDecision: 'APPROVED',
  checks: 'SUCCESS',
  createdAt: '2026-11-20T10:00:00Z',
  updatedAt: '2026-11-21T10:00:00Z',
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  headRef: 'eng-7',
  headSha: 'd'.repeat(40),
  baseRef: 'main',
  author: { login: 'dana', avatarUrl: null },
  labels: [],
  assignees: [],
  permission: 'WRITE',
  mergeMethods: ['squash'],
  linked: [],
}

let container: HTMLDivElement
let right: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('fetch', async () =>
    new Response(
      JSON.stringify({
        pr: PR,
        body: 'Fixes it.',
        checks: [{ name: 'test', outcome: 'success', url: 'https://ci.test/1' }],
        files: [],
        mergeBlocker: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  )
  container = document.createElement('div')
  right = document.createElement('div')
  document.body.append(right, container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  vi.unstubAllGlobals()
})

async function mount(inCard: boolean) {
  const page = React.createElement(PullDetail, { prKey: 'acme/app#7', summary: PR, onClose: () => {}, onMerged: () => {}, onOpenAction: () => {} })
  const tree = inCard
    ? React.createElement(CardHeaderSlotsProvider, { value: { left: null, right } }, React.createElement(WindowPropertiesProvider, null, page))
    : page
  await act(async () => root.render(tree))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('a pull request’s sections', () => {
  it('in a card: a capsule in the header, counted; a press switches; no row over the title', async () => {
    await mount(true)
    const capsule = right.querySelector<HTMLElement>('[data-detail-tabs="header"]')!
    expect(capsule).not.toBeNull()
    expect(capsule.getAttribute('aria-label')).toBe('Pull request')
    expect(Array.from(capsule.querySelectorAll('[role="tab"]')).map((b) => b.textContent)).toEqual(['Description', 'Files changed2', 'Checks1'])
    expect(capsule.querySelector('[data-reviews-tab="description"]')!.getAttribute('aria-selected')).toBe('true')
    // The row is left empty (Merge and GitHub in the Properties popover), so it hides.
    const row = container.querySelector<HTMLElement>('[data-reviews-toolbar]')!
    expect(row.childNodes.length).toBe(0)
    expect(row.className).toContain('empty:hidden')
    expect(container.querySelector('[role="tablist"]')).toBeNull()

    await act(async () => capsule.querySelector<HTMLButtonElement>('[data-reviews-tab="checks"]')!.click())
    expect(capsule.querySelector('[data-reviews-tab="checks"]')!.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-reviews-checks]')!.textContent).toContain('test')
  })

  it('on its own: the row of pills, as before', async () => {
    await mount(false)
    expect(right.childElementCount).toBe(0)
    const row = container.querySelector<HTMLElement>('[data-reviews-toolbar]')!
    expect(row.querySelector('[role="tablist"] [data-reviews-tab="files"]')).not.toBeNull()
    await act(async () => row.querySelector<HTMLButtonElement>('[data-reviews-tab="checks"]')!.click())
    expect(container.querySelector('[data-reviews-checks]')).not.toBeNull()
  })
})
