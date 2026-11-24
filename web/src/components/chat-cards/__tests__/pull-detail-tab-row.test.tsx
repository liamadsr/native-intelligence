// @vitest-environment jsdom
/**
 * A pull request's Description / Files changed / Checks on the page's first
 * row, from the far left (Liam, 11-23: "make it look really nice and clean
 * like linear does … it should start to the far left even though the page
 * content is indented"): a tablist on the 18px line, the counts after the
 * words, a press switching what the page shows; none in the card's header.
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
  it('in a card: the page’s first row, from the far left, counted; a press switches; none in the header', async () => {
    await mount(true)
    expect(right.querySelector('[role="tablist"]')).toBeNull()
    const row = container.querySelector<HTMLElement>('[data-reviews-toolbar]')!
    expect(row.className).toContain('px-2.5')
    expect(row.className).not.toContain('max-w-[736px]')
    const tabs = row.querySelector<HTMLElement>('[role="tablist"]')!
    expect(tabs.getAttribute('aria-label')).toBe('Pull request')
    expect(Array.from(tabs.querySelectorAll('[role="tab"]')).map((b) => b.textContent)).toEqual(['Description', 'Files changed2', 'Checks1'])
    expect(tabs.querySelector('[data-reviews-tab="description"]')!.getAttribute('aria-selected')).toBe('true')

    await act(async () => tabs.querySelector<HTMLButtonElement>('[data-reviews-tab="checks"]')!.click())
    expect(tabs.querySelector('[data-reviews-tab="checks"]')!.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-reviews-checks]')!.textContent).toContain('test')
  })

  it('on its own: the same row', async () => {
    await mount(false)
    expect(right.childElementCount).toBe(0)
    const row = container.querySelector<HTMLElement>('[data-reviews-toolbar]')!
    expect(row.querySelector('[role="tablist"] [data-reviews-tab="files"]')).not.toBeNull()
    await act(async () => row.querySelector<HTMLButtonElement>('[data-reviews-tab="checks"]')!.click())
    expect(container.querySelector('[data-reviews-checks]')).not.toBeNull()
  })
})
