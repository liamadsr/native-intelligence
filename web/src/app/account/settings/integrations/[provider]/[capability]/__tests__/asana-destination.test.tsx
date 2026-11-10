// @vitest-environment jsdom
/**
 * The Asana destination picker in IntegrationDetailView — three defects that
 * are all invisible from the component's own state and only show up in the
 * PATCH body it sends (or in what it renders when a fetch fails):
 *
 * 1. picking ONE bucket's section persisted all four, because the payload was
 *    spread from the DISPLAY map — which is name-heuristic guesses when the
 *    workspace has never saved a map. The user's project silently acquired
 *    three mappings they never chose.
 * 2. switching projects kept the previous project's section gids. Section gids
 *    are project-scoped, so the saved map pointed at sections that don't exist
 *    in the new project.
 * 3. every picker fetch failure collapsed to an empty array, so a dead token
 *    rendered empty dropdowns with no explanation at all.
 *
 * Radix's Select can't be driven in jsdom (it needs pointer-capture APIs jsdom
 * doesn't implement), so it's replaced with a native <select> that calls the
 * same onValueChange. The project list is plain buttons and is clicked for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))
vi.mock('../../../../settings-shell', () => ({ useSettingsNavigate: () => vi.fn() }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => false }))

// Radix Select → native <select>. Trigger/Value render nothing; Content is a
// pass-through so the items stay direct children of the select element.
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
      { value: value ?? '', onChange: (e: { target: { value: string } }) => onValueChange?.(e.target.value) },
      children,
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => h('optgroup', {}, children),
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) =>
    h('option', { value }, children),
}))

import { IntegrationDetailView } from '../integration-detail-view'

// ---- fetch fake ------------------------------------------------------------

interface FetchConfig {
  /** Saved task_sync_state.config returned by the settings GET. */
  config?: Record<string, unknown>
  sections?: Array<{ gid: string; name: string }>
  /** Per-path override: a non-ok response body for a picker route. */
  fail?: { path: string; status: number; body: Record<string, unknown> }
  /**
   * Fail the settings PATCH only. Separate from `fail` because that matches by
   * path prefix, which would take the settings GET down with it and leave
   * nothing to save in the first place.
   */
  failPatch?: { status: number; body: Record<string, unknown> }
}

let patches: Array<Record<string, unknown>> = []

function installFetch(cfg: FetchConfig = {}) {
  patches = []
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)

      if (cfg.fail && url.startsWith(cfg.fail.path)) {
        return {
          ok: false,
          status: cfg.fail.status,
          json: async () => cfg.fail!.body,
        }
      }

      if (url.startsWith('/api/oauth/status')) {
        return json({
          accounts: [
            {
              id: 'acct-1',
              provider: 'asana',
              capability: 'tasks',
              account_email: 'ada@example.com',
              display_name: null,
              color: '#F06A6A',
              is_enabled: true,
              is_primary: true,
              workspace_ids: ['ws-1'],
              scopes: [],
            },
          ],
        })
      }
      if (url.startsWith('/api/account/workspace/list')) {
        return json({ workspaces: [{ id: 'ws-1', name: 'Acme' }] })
      }
      if (url.startsWith('/api/account/workspace/asana-settings')) {
        if (init?.method === 'PATCH') {
          patches.push(JSON.parse(String(init.body)))
          if (cfg.failPatch) {
            return {
              ok: false,
              status: cfg.failPatch.status,
              json: async () => cfg.failPatch!.body,
            }
          }
          return json({ connected: true, accountId: 'acct-1', config: {} })
        }
        return json({ connected: true, accountId: 'acct-1', config: cfg.config ?? {} })
      }
      if (url.startsWith('/api/account/asana/workspaces')) {
        return json({ workspaces: [{ gid: 'aw-1', name: 'Acme' }] })
      }
      if (url.startsWith('/api/account/asana/projects')) {
        return json({
          projects: [
            { gid: 'proj-1', name: 'Engineering' },
            { gid: 'proj-2', name: 'Growth' },
          ],
        })
      }
      if (url.startsWith('/api/account/asana/sections')) {
        return json({
          sections: cfg.sections ?? [
            { gid: 's-todo', name: 'To Do' },
            { gid: 's-doing', name: 'In Progress' },
            { gid: 's-done', name: 'Done' },
            { gid: 's-cancelled', name: 'Cancelled' },
          ],
        })
      }
      return json({})
    }) as unknown as typeof fetch,
  )
}

const SAVED_DESTINATION = {
  asana_workspace_gid: 'aw-1',
  asana_workspace_name: 'Acme',
  project_gid: 'proj-1',
  project_name: 'Engineering',
}

// ---- harness ---------------------------------------------------------------

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

async function mount() {
  await act(async () => {
    root.render(
      h(IntegrationDetailView, {
        provider: 'asana',
        capability: 'tasks',
        name: 'Asana',
        description: 'Push actions to Asana',
      }),
    )
  })
  // Mount fetches, then the project/section fetches they unlock.
  await flush()
  await flush()
  await flush()
}

/** Set a native <select>'s value the way React's change handler will see it. */
function selectOption(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    'value',
  )!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function bucketSelects(): HTMLSelectElement[] {
  // [0] is the Asana-workspace picker; the rest are the four lifecycle buckets
  // in LIFECYCLE_BUCKETS order (not_started, in_progress, done, canceled).
  return [...container.querySelectorAll('select')].slice(1) as HTMLSelectElement[]
}

function projectButton(label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  )
  expect(btn, `project button "${label}"`).toBeTruthy()
  return btn as HTMLButtonElement
}

function clearButton(): HTMLButtonElement {
  return projectButton('Clear destination')
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

// ---- 1. section map: only explicit picks persist ---------------------------

describe('Asana section map — guesses are prefill, not choices', () => {
  it('persists ONLY the bucket the user changed, never the name-heuristic guesses', async () => {
    // No section_map has ever been saved, so all four dropdowns render guesses.
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    const selects = bucketSelects()
    expect(selects).toHaveLength(4)
    // The guesses ARE displayed (that's their job) …
    expect(selects[0].value).toBe('s-todo')
    expect(selects[1].value).toBe('s-doing')
    expect(selects[3].value).toBe('s-cancelled')

    // … but choosing one bucket must not enshrine the other three.
    await act(async () => selectOption(selects[2], 's-done'))
    await flush()

    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual({ section_map: { done: 's-done' } })
  })

  it('merges an explicit pick onto the SAVED map, keeping the other saved buckets', async () => {
    installFetch({
      config: {
        ...SAVED_DESTINATION,
        section_map: {
          not_started: 's-todo',
          in_progress: null,
          done: null,
          canceled: null,
        },
      },
    })
    await mount()

    await act(async () => selectOption(bucketSelects()[2], 's-done'))
    await flush()

    expect(patches[0]).toEqual({
      section_map: { not_started: 's-todo', in_progress: null, done: 's-done', canceled: null },
    })
  })

  it('sends null (not the sentinel) when a bucket is set back to "Don\'t move"', async () => {
    installFetch({
      config: {
        ...SAVED_DESTINATION,
        section_map: { not_started: 's-todo', in_progress: null, done: 's-done', canceled: null },
      },
    })
    await mount()

    await act(async () => selectOption(bucketSelects()[2], '__none__'))
    await flush()

    expect(patches[0]).toEqual({
      section_map: { not_started: 's-todo', in_progress: null, done: null, canceled: null },
    })
  })
})

// ---- 2. project switch clears the section map ------------------------------

describe('Asana project switch — cross-project section gids are cleared', () => {
  it('sends an explicit all-null section_map when the project actually changes', async () => {
    installFetch({
      config: {
        ...SAVED_DESTINATION,
        section_map: { not_started: 's-todo', in_progress: null, done: 's-done', canceled: null },
      },
    })
    await mount()

    await act(async () => projectButton('Growth').click())
    await flush()

    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual({
      project_gid: 'proj-2',
      project_name: 'Growth',
      asana_workspace_gid: 'aw-1',
      asana_workspace_name: 'Acme',
      section_map: { not_started: null, in_progress: null, done: null, canceled: null },
    })
  })

  it('leaves the map alone when the user re-picks the SAME project', async () => {
    installFetch({
      config: {
        ...SAVED_DESTINATION,
        section_map: { not_started: 's-todo', in_progress: null, done: 's-done', canceled: null },
      },
    })
    await mount()

    await act(async () => projectButton('Engineering').click())
    await flush()

    expect(patches).toHaveLength(1)
    expect(patches[0]).not.toHaveProperty('section_map')
  })
})

// ---- 2b. clearing the destination ------------------------------------------

describe('Asana destination clear', () => {
  it('REGRESSION: offers a way OUT of a destination, PATCHing {project_gid: null}', async () => {
    // The picker can only ever set a project, and every other PATCH merges, so
    // without this button a workspace that picked a project was stuck pushing to
    // it forever. `{project_gid: null}` alone is the route's explicit clear.
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    await act(async () => clearButton().click())
    await flush()

    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual({ project_gid: null })
  })

  it('is hidden until a project is actually configured', async () => {
    // Nothing to clear before then; the workspace picker alone saves nothing.
    installFetch({ config: {} })
    await mount()

    expect(
      [...container.querySelectorAll('button')].some(
        (b) => b.textContent?.trim() === 'Clear destination',
      ),
    ).toBe(false)
  })

  it('optimistically drops the destination from the UI', async () => {
    installFetch({ config: SAVED_DESTINATION })
    await mount()
    expect(container.textContent).toContain('Currently pushing to')

    await act(async () => clearButton().click())
    await flush()

    // The whole destination goes, not just the gid — a leftover project_name
    // would still read as "currently pushing to Engineering".
    expect(container.textContent).not.toContain('Currently pushing to')
    expect(
      [...container.querySelectorAll('button')].some(
        (b) => b.textContent?.trim() === 'Clear destination',
      ),
    ).toBe(false)
  })

  it('REVERTS the optimistic clear when the PATCH fails', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      failPatch: { status: 500, body: { error: 'Failed to save Asana settings' } },
    })
    await mount()

    await act(async () => clearButton().click())
    await flush()

    expect(container.textContent).toContain('Failed to save Asana settings')
    expect(container.textContent).toContain('Currently pushing to')
  })
})

// ---- 3. picker failures are surfaced, not swallowed ------------------------

describe('Asana picker failures', () => {
  it('shows the reconnect banner INSTEAD of the pickers on reconnect_required', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      fail: {
        path: '/api/account/asana/workspaces',
        status: 400,
        body: { error: 'Reconnect Asana to continue', code: 'reconnect_required' },
      },
    })
    await mount()

    const text = container.textContent || ''
    expect(text).toContain('Reconnect Asana to manage the destination')
    const reconnect = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Reconnect Asana',
    )
    expect(reconnect).toBeTruthy()
    // The dropdowns are hidden — an empty picker reads as "you have no projects".
    expect(text).not.toContain('Asana workspace')
    expect(container.querySelectorAll('select')).toHaveLength(0)
  })

  it('treats not_connected the same way (same fix: reconnect)', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      fail: {
        path: '/api/account/asana/workspaces',
        status: 400,
        body: { error: 'Asana is not connected for this workspace', code: 'not_connected' },
      },
    })
    await mount()

    expect(container.textContent).toContain('Reconnect Asana to manage the destination')
  })

  it('shows an inline error with a Retry for a generic failure, keeping the pickers', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      fail: {
        path: '/api/account/asana/projects',
        status: 500,
        body: { error: 'Failed to list Asana projects' },
      },
    })
    await mount()

    const text = container.textContent || ''
    expect(text).toContain('Failed to list Asana projects')
    expect(text).not.toContain('Reconnect Asana to manage the destination')
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Retry'),
    ).toBe(true)
    // The workspace picker still renders — only the projects call failed.
    expect(text).toContain('Asana workspace')
  })

  it('recovers on Retry once the route is healthy again', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      fail: {
        path: '/api/account/asana/projects',
        status: 500,
        body: { error: 'Failed to list Asana projects' },
      },
    })
    await mount()
    expect(container.textContent).toContain('Failed to list Asana projects')

    installFetch({ config: SAVED_DESTINATION })
    const retry = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Retry',
    ) as HTMLButtonElement
    await act(async () => retry.click())
    await flush()
    await flush()

    expect(container.textContent).not.toContain('Failed to list Asana projects')
    expect(container.textContent).toContain('Growth')
  })
})

// ---- 4. attribution opt-out ------------------------------------------------

/**
 * The "Pushed from Native Intelligence" toggle. Provider-level, so unlike every other control
 * in this section it is NOT gated on a destination being picked — a user can
 * decide "don't brand my tasks" before ever choosing a project.
 */
describe('Asana attribution toggle', () => {
  function attributionSwitch(): HTMLElement {
    const el = container.querySelector(
      '[aria-label="Include a “Pushed from Native Intelligence” link on pushed tasks"]',
    )
    expect(el, 'attribution switch').toBeTruthy()
    return el as HTMLElement
  }

  it('renders for a connected account with NO destination picked', async () => {
    installFetch({ config: {} })
    await mount()

    expect(container.textContent).toContain(
      'Include a “Pushed from Native Intelligence” link on pushed tasks',
    )
    // Absent in the saved config = ON, the server's default.
    expect(attributionSwitch().getAttribute('data-state')).toBe('checked')
  })

  it('renders OFF when the workspace has opted out', async () => {
    installFetch({ config: { ...SAVED_DESTINATION, include_dial8_attribution: false } })
    await mount()

    expect(attributionSwitch().getAttribute('data-state')).toBe('unchecked')
  })

  it('PATCHes the flag ALONE — it is not part of the destination', async () => {
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    await act(async () => attributionSwitch().click())
    await flush()

    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual({ include_dial8_attribution: false })
  })

  it('turns it back ON with an explicit true', async () => {
    installFetch({ config: { ...SAVED_DESTINATION, include_dial8_attribution: false } })
    await mount()

    await act(async () => attributionSwitch().click())
    await flush()

    expect(patches[0]).toEqual({ include_dial8_attribution: true })
  })

  it('REVERTS the optimistic toggle when the PATCH fails', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      failPatch: { status: 500, body: { error: 'Failed to save Asana settings' } },
    })
    await mount()
    expect(attributionSwitch().getAttribute('data-state')).toBe('checked')

    await act(async () => attributionSwitch().click())
    await flush()

    expect(container.textContent).toContain('Failed to save Asana settings')
    expect(attributionSwitch().getAttribute('data-state')).toBe('checked')
  })
})
