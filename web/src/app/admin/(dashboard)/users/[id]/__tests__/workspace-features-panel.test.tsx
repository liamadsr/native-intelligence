// @vitest-environment jsdom
/**
 * The admin console's edition + feature panel — the surface that replaced the
 * user-facing edition dropdown.
 *
 * What this pins is the DERIVED rendering and the cascade, neither of which is
 * visible from the component's own state:
 *
 * 1. Effective state is computed from (edition, overrides) on every render
 *    rather than stored, so an edition's preset decides which switches are on
 *    and a "Custom" badge appears only where an override DEVIATES from it. A
 *    stored override that merely agrees with the preset must not be badged.
 *    Every edition presets every feature now (manifest invariant 5), so the
 *    only way a switch is off is an `off` override, and that is how these
 *    tests make one.
 * 2. `requires` is surfaced BEFORE the click ("Requires CRM…"), which is what
 *    lets the panel stay modal-free — the row says what else will move.
 * 3. Turning a feature on PATCHes its requirements FIRST and threads each
 *    response's overrides into the next call. Order is load-bearing: under
 *    off-wins, a `sequences: 'on'` written while CRM is still off changes
 *    nothing, gets pruned by the route, and the gesture half-lands.
 * 4. `core` is locked — it renders "Always on" with no switch, in every edition.
 *
 * Radix's Select and Switch can't be driven in jsdom (they need pointer-capture
 * APIs jsdom doesn't implement), so both are replaced with plain elements that
 * forward the same callbacks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
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

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (v: string) => void
    children?: ReactNode
  }) =>
    h(
      'select',
      {
        'data-testid': 'edition-select',
        value: value ?? '',
        onChange: (e: { target: { value: string } }) => onValueChange?.(e.target.value),
      },
      children,
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => h('optgroup', {}, children),
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) =>
    h('option', { value }, children),
}))

import { WorkspaceFeaturesPanel } from '../workspace-features-panel'
import { ADMIN_TOGGLEABLE_FEATURE_KEYS, EDITIONS } from '@/lib/editions'

/** One switch per toggleable feature — derived, so adding a feature to the
 *  manifest widens this instead of failing an out-of-date literal. */
// The ADMIN panel renders every non-locked feature — HIDDEN ones included,
// because the admin switch is the only way one is ever turned on.
const TOGGLEABLE_COUNT = ADMIN_TOGGLEABLE_FEATURE_KEYS.length

/** A workspace row as the server component builds it. */
function ws(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    name: 'Acme',
    slug: 'acme',
    plan: 'free',
    role: 'owner',
    edition: 'notes',
    overrides: {},
    ...overrides,
  } as Parameters<typeof WorkspaceFeaturesPanel>[0]['workspaces'][number]
}

describe('WorkspaceFeaturesPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    refresh.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function render(workspaces: Parameters<typeof WorkspaceFeaturesPanel>[0]['workspaces']) {
    await act(async () => {
      root.render(h(WorkspaceFeaturesPanel, { workspaces }))
    })
  }

  /** The switch for one feature, found by the aria-label the panel sets. */
  function switchFor(featureLabel: string): HTMLButtonElement {
    const el = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="switch"]')].find(
      (b) => b.dataset.label?.endsWith(`— ${featureLabel}`),
    )
    if (!el) throw new Error(`no switch for ${featureLabel}`)
    return el
  }

  function isOn(featureLabel: string): boolean {
    return switchFor(featureLabel).dataset.checked === 'true'
  }

  /** The row <div> containing a given feature label, for scoped assertions. */
  function rowFor(featureLabel: string): HTMLElement {
    const el = [...container.querySelectorAll<HTMLElement>('div')].find(
      (d) =>
        d.className.includes('items-center justify-between gap-4 px-3') &&
        d.textContent?.includes(featureLabel),
    )
    if (!el) throw new Error(`no row for ${featureLabel}`)
    return el
  }

  it('renders an empty state for a user with no workspaces', async () => {
    await render([])
    expect(container.textContent).toContain('No workspaces.')
    expect(container.querySelectorAll('[data-testid="switch"]').length).toBe(0)
  })

  it('renders a notes workspace against its PRESET — every feature on, nothing Custom', async () => {
    await render([ws()])

    // notes presets every feature, like full: the edition is a persona now.
    expect(isOn('Documents')).toBe(true)
    expect(isOn('Team boards')).toBe(true)
    expect(isOn('Email')).toBe(true)
    expect(isOn('CRM')).toBe(true)
    expect(isOn('Sequences')).toBe(true)

    // The Select reflects the stored edition, and its description follows.
    const select = container.querySelector<HTMLSelectElement>('[data-testid="edition-select"]')!
    expect(select.value).toBe('notes')
    expect(container.textContent).toContain('Meeting notes')

    // No override deviates from the preset, so nothing is badged or resettable.
    expect(container.textContent).not.toContain('Custom')
    expect(container.textContent).not.toContain('Reset')

    // Role and plan travel with the workspace.
    expect(container.textContent).toContain('owner')
    expect(container.textContent).toContain('free')
  })

  it('surfaces an unmet requirement on the Sequences row before any click', async () => {
    await render([ws({ overrides: { crm: 'off' } })])
    // Sequences requires CRM, which this workspace has switched off.
    expect(isOn('Sequences')).toBe(false)
    expect(rowFor('Sequences').textContent).toContain('Requires CRM')
    expect(rowFor('Sequences').textContent).toContain('Turning this on also enables it')
  })

  it('badges an override that DEVIATES from the preset, and offers a Reset', async () => {
    await render([ws({ overrides: { email: 'off' } })])

    expect(isOn('Email')).toBe(false)
    expect(rowFor('Email').textContent).toContain('Custom')
    expect(rowFor('Email').querySelector('button')?.textContent).toContain('Reset')

    // A feature merely following the preset is neither badged nor resettable.
    expect(rowFor('Documents').textContent).not.toContain('Custom')
    expect(rowFor('Documents').textContent).not.toContain('Reset')
  })

  it('renders a full workspace with everything on and core locked', async () => {
    await render([ws({ edition: 'full' })])

    for (const label of [
      'Documents',
      'Team boards',
      'Knowledge graph',
      'Projects',
      'Flows',
      'Email',
      'CRM',
      'Sequences',
    ]) {
      expect(isOn(label)).toBe(true)
    }

    // core is locked: no switch at all, just the "Always on" affordance.
    expect(rowFor('Core').textContent).toContain('Always on')
    expect(rowFor('Core').querySelector('[data-testid="switch"]')).toBeNull()
    // One switch per toggleable feature — core contributes none.
    expect(container.querySelectorAll('[data-testid="switch"]').length).toBe(TOGGLEABLE_COUNT)
  })

  it('shows Evals as an ordinary row that is ON on a pristine workspace', async () => {
    await render([ws({ edition: 'full' })])
    // Evals used to be OPT-IN (off in every preset). It is a default-on feature
    // now, so the row is on, with neither the "Staff only" nor the
    // "Off by default" note, and no Custom marker.
    expect(isOn('Evals')).toBe(true)
    const row = rowFor('Evals')
    expect(row.textContent).not.toContain('Staff only')
    expect(row.textContent).not.toContain('Off by default')
    expect(row.textContent).not.toContain('Custom')
  })

  it('an `evals: off` override reads as off AND Custom; a leftover `on` is neither', async () => {
    await render([ws({ id: 'ws-1', edition: 'full', overrides: { evals: 'off' } })])
    expect(isOn('Evals')).toBe(false)
    expect(rowFor('Evals').textContent).toContain('Custom')

    // A stored `evals: on` from when Evals was opt-in agrees with the preset
    // now, so it must not be badged.
    await render([ws({ id: 'ws-2', edition: 'full', overrides: { evals: 'on' } })])
    expect(isOn('Evals')).toBe(true)
    expect(rowFor('Evals').textContent).not.toContain('Custom')
  })

  it('turning Sequences on PATCHes crm FIRST, then sequences, threading the response', async () => {
    // Order is the point: under off-wins a `sequences: 'on'` written while CRM
    // is still off changes nothing and the route prunes it away, so the gesture
    // would half-land. Each call must also be computed against the map the
    // PREVIOUS one returned, not a stale local copy.
    const calls: { url: string; body: unknown; at: number }[] = []
    let resolveCrm: (() => void) | null = null
    const crmInFlight = new Promise<void>((r) => {
      resolveCrm = r
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        calls.push({ url, body, at: calls.length })
        if (body.feature === 'crm') {
          // Hold the first PATCH open so a second call arriving early would be
          // observable rather than merely out of order.
          await crmInFlight
          // The route collapses `crm: on` (every preset grants it), so the
          // stored `off` is simply gone.
          return { ok: true, json: async () => ({ overrides: {} }) } as Response
        }
        return { ok: true, json: async () => ({ overrides: {} }) } as Response
      }),
    )

    // CRM switched off takes Sequences with it, so turning Sequences on has an
    // unmet requirement to cascade.
    await render([ws({ overrides: { crm: 'off' } })])
    expect(isOn('Sequences')).toBe(false)

    let toggled: Promise<void>
    await act(async () => {
      toggled = Promise.resolve().then(() => {
        switchFor('Sequences').click()
      })
      await toggled
    })

    // Only the requirement has been sent while it is still in flight.
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('/api/admin/workspaces/ws-1/features')
    expect(calls[0].body).toEqual({ feature: 'crm', state: 'on' })

    await act(async () => {
      resolveCrm!()
      await new Promise((r) => setTimeout(r, 0))
    })

    // The second PATCH lands only after the first resolved.
    expect(calls.length).toBe(2)
    expect(calls[1].url).toBe('/api/admin/workspaces/ws-1/features')
    expect(calls[1].body).toEqual({ feature: 'sequences', state: 'on' })

    // Both rows end up on, from the map the LAST response returned.
    expect(isOn('Sequences')).toBe(true)
    expect(isOn('CRM')).toBe(true)
    expect(refresh).toHaveBeenCalled()
  })

  it('rolls the switches back and shows the error when a PATCH fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({ error: 'nope' }) }) as Response),
    )

    await render([ws()])
    expect(isOn('Email')).toBe(true)
    await act(async () => {
      switchFor('Email').click()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(isOn('Email')).toBe(true)
    expect(container.textContent).toContain('nope')
  })

  it('PATCHes the edition route when the Select changes', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) })
        return { ok: true, json: async () => ({ edition: 'sales' }) } as Response
      }),
    )

    await render([ws()])
    const select = container.querySelector<HTMLSelectElement>('[data-testid="edition-select"]')!
    await act(async () => {
      select.value = 'sales'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(calls).toEqual([
      { url: '/api/admin/workspaces/ws-1/edition', body: { edition: 'sales' } },
    ])
    // The whole card re-bases on the new edition with no refetch: its
    // description follows, and every feature stays on, because sales grants
    // every feature just as notes does.
    expect(container.textContent).toContain(EDITIONS.sales.description)
    expect(container.textContent).not.toContain(EDITIONS.notes.description)
    expect(isOn('CRM')).toBe(true)
    expect(isOn('Email')).toBe(true)
  })

  it('renders one card per workspace and scopes writes to the right id', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return { ok: true, json: async () => ({ overrides: { email: 'off' } }) } as Response
      }),
    )

    await render([
      ws({ id: 'ws-1', name: 'Acme' }),
      ws({ id: 'ws-2', name: 'Globex', edition: 'full', role: 'member' }),
    ])

    expect(container.textContent).toContain('Acme')
    expect(container.textContent).toContain('Globex')
    // One switch per toggleable feature, per workspace.
    expect(container.querySelectorAll('[data-testid="switch"]').length).toBe(TOGGLEABLE_COUNT * 2)

    // The Globex (full) Email switch is the second one bearing that label.
    const globexEmail = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-testid="switch"]'),
    ].filter((b) => b.dataset.label === 'Globex — Email')[0]
    await act(async () => {
      globexEmail.click()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(calls).toEqual(['/api/admin/workspaces/ws-2/features'])
  })
})
