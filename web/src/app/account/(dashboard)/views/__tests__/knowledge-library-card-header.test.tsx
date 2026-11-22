// @vitest-environment jsdom
/**
 * The Library in its card (../knowledge-library.tsx; Liam, 11-22: a page's
 * controls live in its card's header, and a place inside it is the header's
 * breadcrumb): the Review queue and Refresh briefs are the header's, not the
 * workspace brief's row; a package open in its panel is "Library › <package>",
 * the title its way back, with no label and close of the panel's own; and
 * while a record is open over the page, the header is the record's. Outside
 * a card the brief's row keeps both buttons (the other tests in this folder).
 * Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('../review-queue-dialog', () => ({
  ReviewQueueDialog: ({ children }: { children?: ReactNode }) => h('div', { 'data-review-dialog': '' }, children),
}))
vi.mock('@/components/ui/markdown', () => ({ Markdown: () => h('div', null, 'md') }))
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@/lib/download', () => ({ downloadFile: vi.fn(async () => 'x') }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { KnowledgeLibrary } from '../knowledge-library'
import { CardHeaderSlotsProvider, type CardHeaderBack } from '@/components/chat-cards/card-header-slot'
import { CardCovered } from '@/components/chat-cards/card-covered'

const LIBRARY = {
  workspace_brief: { content: 'Fernhill Studio makes garden furniture.', generated_at: '2026-11-20T09:00:00Z' },
  total_claims: 12,
  suggested_claims: 3,
  projects: [],
  packages: [
    {
      id: 'pkg-launch',
      name: 'Spring launch',
      slug: 'spring-launch',
      description: null,
      visibility: 'workspace',
      team_id: null,
      rules: {},
      pinned_items: 2,
      updated_at: '2026-11-20T09:00:00Z',
      has_brief: false,
    },
  ],
}

let container: HTMLDivElement
let right: HTMLDivElement
let trail: HTMLDivElement
let root: Root
let back: CardHeaderBack | null
const setBack = vi.fn((next: CardHeaderBack | null) => {
  back = next
})

beforeEach(() => {
  back = null
  setBack.mockClear()
  container = document.createElement('div')
  right = document.createElement('div')
  trail = document.createElement('div')
  document.body.append(container, right, trail)
  root = createRoot(container)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/knowledge/library')) return new Response(JSON.stringify(LIBRARY), { status: 200 })
      if (url.includes('/shares')) return new Response(JSON.stringify({ shares: [] }), { status: 200 })
      if (url.includes('/workspace/members')) return new Response(JSON.stringify({ members: [] }), { status: 200 })
      // The package's detail never comes: the panel stays loading, its name the Library's.
      if (url.includes('/knowledge-packages/')) return new Promise<Response>(() => {})
      return new Response('{}', { status: 200 })
    }),
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  trail.remove()
  vi.unstubAllGlobals()
})

async function render(props: Record<string, unknown> = {}, covered = false) {
  await act(async () => {
    root.render(
      h(CardHeaderSlotsProvider, { value: { left: null, right, trail, setBack } }, h(CardCovered, { covered }, h(KnowledgeLibrary, props))),
    )
  })
  for (let i = 0; i < 3; i++) await act(async () => {})
}

describe('the Library in its card', () => {
  it('puts the Review queue and Refresh briefs in the header, not in the brief’s row', async () => {
    await render()
    const controls = right.querySelector('[data-library-header-controls]')!
    expect(controls).not.toBeNull()
    expect(controls.querySelector('[data-library-review-queue]')!.textContent).toContain('Review queue')
    expect(controls.querySelector('[data-library-review-queue]')!.textContent).toContain('3')
    expect(controls.querySelector('[data-library-refresh-briefs]')!.getAttribute('aria-label')).toBe('Refresh briefs')
    // The page: the brief is content, its own row holds neither button.
    expect(container.textContent).toContain('Workspace brief')
    expect(container.textContent).not.toContain('Review queue')
    expect(container.textContent).not.toContain('Refresh briefs')
  })

  it('names an open package in the breadcrumb; the title closes it; the panel draws no label or close of its own', async () => {
    const changes: unknown[] = []
    await render({ onPackageChange: (pkg: unknown) => changes.push(pkg) })
    await act(async () => {
      const row = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Spring launch'))!
      row.click()
    })
    expect(container.querySelector('[data-library-package-panel="pkg-launch"]')).not.toBeNull()
    expect(trail.querySelector('[data-library-package-trail]')!.textContent).toBe('Spring launch')
    expect(back?.label).toBe('Back to the library')
    expect(container.querySelector('button[aria-label="Close"]')).toBeNull()
    // The header's title is the way back.
    await act(async () => back!.go())
    expect(container.querySelector('[data-library-package-panel]')).toBeNull()
    expect(trail.querySelector('[data-library-package-trail]')).toBeNull()
    expect(changes).toEqual([{ id: 'pkg-launch', name: 'Spring launch' }, null])
    expect(setBack).toHaveBeenLastCalledWith(null)
  })

  it('leaves the header to a record open over the page', async () => {
    await render({ initialPackageId: 'pkg-launch' }, true)
    expect(right.childElementCount).toBe(0)
    expect(trail.childElementCount).toBe(0)
  })
})
