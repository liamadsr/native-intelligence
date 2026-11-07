// @vitest-environment jsdom
/**
 * KnowledgeLibrary `initialPackageId` deep link (Loops v3 Phase 4, W-D). A work
 * run's package resource chip navigates to {kind:'knowledge', initialPackageId},
 * which tab-content threads into KnowledgeView → KnowledgeLibrary. The library
 * opens its PackagePanel for that id ONCE (read-once, mirroring AgentsView's
 * initialItemId): closing the panel must not re-open it, and re-rendering with
 * the same id is a no-op.
 *
 * We mount the library standalone with createRoot. The heavy leaves (review
 * dialog, markdown, confirm dialog, download) are stubbed; the network is stubbed
 * so the list loads empty and the PackagePanel stays in its loading state (its
 * header "Package" is enough to prove it opened without rendering Radix Select/
 * Dialog trees). The read-once logic under test is real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Fixed workspace so the library's mount fetch fires.
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
// Live-sync is a no-op in the test (no realtime).
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
// Heavy leaves → inert stubs.
vi.mock('../review-queue-dialog', () => ({
  ReviewQueueDialog: ({ children }: { children?: React.ReactNode }) => h('div', null, children),
}))
vi.mock('@/components/ui/markdown', () => ({ Markdown: () => h('div', null, 'md') }))
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@/lib/download', () => ({ downloadFile: vi.fn(async () => 'x') }))

import { KnowledgeLibrary } from '../knowledge-library'

let container: HTMLDivElement
let root: Root

const EMPTY_LIBRARY = {
  workspace_brief: null,
  total_claims: 0,
  suggested_claims: 0,
  projects: [],
  packages: [],
}

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/knowledge/library')) {
      return new Response(JSON.stringify(EMPTY_LIBRARY), { status: 200 })
    }
    // The package-detail / shares / members fetches: return empty-ish payloads so
    // the panel resolves but renders no Radix trees to speak of. `package` detail
    // keeps the panel mounted; the header proves it opened.
    if (url.includes('/knowledge-packages/')) {
      if (url.includes('/shares')) return new Response(JSON.stringify({ shares: [] }), { status: 200 })
      // Never fully resolve package detail — keep the panel in its loading state
      // (header-only) so we don't have to render its Select/Dialog subtree.
      return new Promise<Response>(() => {})
    }
    if (url.includes('/workspace/members')) {
      return new Response(JSON.stringify({ members: [] }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
}

async function flush() {
  // Let the mount fetch + setState settle.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('KnowledgeLibrary — initialPackageId deep link', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('fetch', stubFetch())
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('opens the PackagePanel for the deep-linked id on mount', async () => {
    await act(async () => {
      root.render(h(KnowledgeLibrary, { initialPackageId: 'pkg-42' }))
    })
    await flush()
    // The PackagePanel header is the "Package" uppercase label.
    expect(container.textContent).toContain('Package')
    // It requested the package by id.
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(calls.some((u) => u.includes('/knowledge-packages/pkg-42'))).toBe(true)
  })

  it('does NOT re-open after the panel is closed (consume-once)', async () => {
    await act(async () => {
      root.render(h(KnowledgeLibrary, { initialPackageId: 'pkg-42' }))
    })
    await flush()
    // Close the panel via its aria-labelled Close button.
    const closeBtn = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement | null
    expect(closeBtn).toBeTruthy()
    act(() => closeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // Re-render with the SAME id — the consume-once ref must keep it closed.
    await act(async () => {
      root.render(h(KnowledgeLibrary, { initialPackageId: 'pkg-42' }))
    })
    await flush()
    expect(container.querySelector('button[aria-label="Close"]')).toBeNull()
  })

  it('does not open any panel when initialPackageId is absent', async () => {
    await act(async () => {
      root.render(h(KnowledgeLibrary, {}))
    })
    await flush()
    expect(container.querySelector('button[aria-label="Close"]')).toBeNull()
  })

  it('closes on history Back to the library and opens the same package on Forward', async () => {
    await act(async () => root.render(h(KnowledgeLibrary, { initialPackageId: 'pkg-42' })))
    await flush()
    expect(container.querySelector('button[aria-label="Close"]')).not.toBeNull()
    await act(async () => root.render(h(KnowledgeLibrary, {})))
    expect(container.querySelector('button[aria-label="Close"]')).toBeNull()
    await act(async () => root.render(h(KnowledgeLibrary, { initialPackageId: 'pkg-42' })))
    await flush()
    expect(container.querySelector('button[aria-label="Close"]')).not.toBeNull()
  })
})

/**
 * A package the person opens (or closes) is told to whoever asked: a chat
 * card keeps it as where the card is, for the agent's note and read_card.
 */
describe('KnowledgeLibrary — onPackageChange', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const pkg = { id: 'pkg-7', name: 'Sales playbook', slug: 'sales', description: null, visibility: 'workspace', team_id: null, rules: {}, pinned_items: 2, updated_at: new Date().toISOString(), has_brief: false }
    const base = stubFetch()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/knowledge/library')) return new Response(JSON.stringify({ ...EMPTY_LIBRARY, packages: [pkg] }), { status: 200 })
      return base(input)
    }))
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('reports the package opened, and null when it closes', async () => {
    const onPackageChange = vi.fn()
    await act(async () => root.render(h(KnowledgeLibrary, { onPackageChange })))
    await flush()
    const row = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Sales playbook')) as HTMLElement
    await act(async () => row.click())
    expect(onPackageChange).toHaveBeenLastCalledWith({ id: 'pkg-7', name: 'Sales playbook' })
    await act(async () => (container.querySelector('button[aria-label="Close"]') as HTMLElement).click())
    expect(onPackageChange).toHaveBeenLastCalledWith(null)
  })
})
