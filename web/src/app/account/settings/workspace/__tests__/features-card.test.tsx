// @vitest-environment jsdom
/**
 * The USER-facing Features card — specifically, that Evals, which used to be an
 * OPT-IN feature, is an ordinary on-by-default row of it now.
 *
 * Evals sat on the far side of a deliberate split: no edition granted it, so it
 * rendered OFF even on a Full workspace, with a muted "Off by default" note.
 * Every workspace gets every feature now (manifest invariant 5), so:
 *
 *   PRESET axis     — every edition grants it, so it renders ON on a Full
 *                     workspace, where `effectiveFeatures` is the `'all'`
 *                     sentinel, and carries no "Off by default" note.
 *   VISIBILITY axis — it is still the owner's to see and toggle: switching it
 *                     off is a deviation from the preset, so the row gets the
 *                     same Custom marker and Reset any other override does.
 *
 * Radix's Switch can't be driven in jsdom (pointer-capture APIs it doesn't
 * implement), so it is replaced with a plain button forwarding the same
 * callback — the same treatment the admin panel's test uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))

vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }))

const refreshCache = vi.fn(async () => {})
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceCacheRefresh: () => refreshCache,
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    'aria-label': ariaLabel,
  }: {
    checked: boolean
    disabled?: boolean
    onCheckedChange: (v: boolean) => void
    'aria-label'?: string
  }) =>
    h('button', {
      'data-testid': 'switch',
      'data-label': ariaLabel,
      'data-checked': String(checked),
      disabled,
      onClick: () => onCheckedChange(!checked),
    }),
}))

// Radix Tooltip/AlertDialog/Select portal into document.body and need pointer
// APIs jsdom lacks; the card's Features section uses none of them, so they are
// flattened to plain passthroughs.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  TooltipTrigger: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  TooltipContent: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  TooltipProvider: ({ children }: { children?: ReactNode }) => h('div', {}, children),
}))

import { WorkspaceSettingsView } from '../workspace-settings-view'
import { FEATURE_LIST, TOGGLEABLE_FEATURE_KEYS } from '@/lib/editions'

/** What the features GET returns, and what the last PATCH sent. */
let featuresResponse: { edition: string; overrides: Record<string, string> }
let patches: { feature: string; state: string }[]

/**
 * A minimal fetch that answers only the routes this card calls on mount, plus
 * the features PATCH. The PATCH echoes the map the real route would store: an
 * `off` is load-bearing (every preset grants every feature) and is kept, while
 * an `on` equals the default everywhere and collapses away.
 */
function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url)
      if (u === '/api/account/workspace/features' && init?.method === 'PATCH') {
        const body = JSON.parse(init.body ?? '{}') as { feature: string; state: string }
        patches.push(body)
        const next = { ...featuresResponse.overrides }
        if (body.state === 'off') next[body.feature] = 'off'
        else delete next[body.feature]
        featuresResponse = { ...featuresResponse, overrides: next }
        return jsonRes({ ...featuresResponse, effectiveFeatures: [] })
      }
      if (u === '/api/account/workspace/features') return jsonRes(featuresResponse)
      if (u === '/api/account/workspace') {
        return jsonRes({
          workspace: {
            id: 'ws-1',
            name: 'Acme',
            slug: 'acme',
            plan: 'free',
            settings: {},
            logo_url: null,
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
          members: [
            {
              id: 'm-1',
              user_id: 'u-1',
              display_name: 'Liam',
              avatar_url: null,
              role: 'owner',
              email: 'liam@example.com',
              created_at: '2026-01-01',
            },
          ],
          invites: [],
          currentMemberId: 'm-1',
          currentRole: 'owner',
        })
      }
      return jsonRes({})
    }),
  )
}

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

describe('Features card — Evals, formerly opt-in', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    patches = []
    refreshCache.mockClear()
    featuresResponse = { edition: 'full', overrides: {} }
    installFetch()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function render() {
    await act(async () => {
      root.render(h(WorkspaceSettingsView))
    })
    // Let the two mount fetches resolve.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  /** The switch for a feature, by its aria-label (the feature's label). */
  function switchFor(label: string): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(
      `[data-testid="switch"][data-label="${label}"]`,
    )
    expect(el, `no switch for ${label}`).not.toBeNull()
    return el!
  }

  /** The row element containing a feature's switch. */
  function rowFor(label: string): HTMLElement {
    let node: HTMLElement | null = switchFor(label)
    // Walk up to the flex row that also holds the label and the notes.
    while (node && !node.textContent?.includes(label)) node = node.parentElement
    expect(node, `no row for ${label}`).not.toBeNull()
    return node!
  }

  it('renders an Evals row — it is in the USER card, not admin-only', () => {
    // Pinned against the manifest rather than a literal, so the card and the
    // route can never disagree about what a user may name.
    expect(FEATURE_LIST.map((f) => f.id)).toContain('evals')
    expect(TOGGLEABLE_FEATURE_KEYS).toContain('evals')
  })

  it('shows Evals ON on a FULL workspace, with no "Off by default" note', async () => {
    await render()

    // The preset axis: `full` is the `'all'` sentinel, and Evals is among the
    // default-on features it means now.
    expect(switchFor('Evals').dataset.checked).toBe('true')
    expect(switchFor('Documents').dataset.checked).toBe('true')
    expect(switchFor('CRM').dataset.checked).toBe('true')

    const row = rowFor('Evals')
    expect(row.textContent).toContain('Grade agents and skills')
    expect(row.textContent).not.toContain('Off by default')
    // Nothing deviates from the preset here, so there is no Custom badge and no
    // Reset.
    expect(row.textContent).not.toContain('Custom')
    expect(row.textContent).not.toContain('Reset')
  })

  it('toggling Evals off PATCHes it and marks the row Custom', async () => {
    await render()

    await act(async () => {
      switchFor('Evals').click()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // One PATCH, no cascade: nothing `requires` Evals.
    expect(patches).toEqual([{ feature: 'evals', state: 'off' }])
    expect(switchFor('Evals').dataset.checked).toBe('false')
    // OFF now DEVIATES from the preset (which grants it everywhere), so the row
    // is Custom — the same marker any other overridden feature gets.
    expect(rowFor('Evals').textContent).toContain('Custom')
    // The nav rail renders from the workspace cache, so a surface-changing
    // toggle must invalidate it or the Evals nav item never goes away.
    expect(refreshCache).toHaveBeenCalled()
  })

  it('toggling Evals back on PATCHes on and returns the row to the default', async () => {
    featuresResponse = { edition: 'full', overrides: { evals: 'off' } }
    await render()
    expect(switchFor('Evals').dataset.checked).toBe('false')
    expect(rowFor('Evals').textContent).toContain('Custom')

    await act(async () => {
      switchFor('Evals').click()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(patches).toEqual([{ feature: 'evals', state: 'on' }])
    expect(switchFor('Evals').dataset.checked).toBe('true')
    // The route collapses an `on` that equals the default, so the key is gone
    // and the row is back to a plain default — no Custom, no stranded key.
    expect(rowFor('Evals').textContent).not.toContain('Custom')
  })
})
