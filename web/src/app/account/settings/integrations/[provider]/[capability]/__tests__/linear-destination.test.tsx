// @vitest-environment jsdom
/**
 * The Linear destination picker in IntegrationDetailView — the behaviours that
 * are invisible from the component's own state and only show up in the PATCH
 * body it sends (or in what it renders when a fetch fails):
 *
 * 1. the state mapping is READ-ONLY and comes from the SERVER. There is no
 *    bucket→state dropdown, by design: `WorkflowState.type` is a stable
 *    seven-value enum, so the mapping is a fact about the team rather than a
 *    preference, and rendering it read-only is what stops the display from ever
 *    disagreeing with what a push and an echo will actually do. A bucket the
 *    team cannot express (a team with no canceled-type state is ordinary) shows
 *    a warning, not a guessed state name.
 * 2. the ORGANIZATION travels with the team. It is not a destination — it is
 *    what the webhook read-back sanity-checks deliveries against — and the teams
 *    call is the only place the client learns it.
 * 3. switching teams drops the project. A Linear project belongs to the teams it
 *    is shared with, so carrying one across produces pushes that fail.
 * 4. the project is OPTIONAL, and "No project" is a real destination rather than
 *    an absence of one — the structural difference from the Jira picker. It
 *    sends the route's `{ project_id: null }` clear shape while KEEPING the team.
 * 5. every save funnel announces `notifyTaskDestinationsChanged`, so the push
 *    menu under the settings overlay stops insisting Linear is unconfigured the
 *    moment it becomes configured (the freshness fix, PR #282).
 * 6. picker fetch failures are classified rather than collapsed to empty arrays.
 *
 * Radix's Select can't be driven in jsdom (it needs pointer-capture APIs jsdom
 * doesn't implement), so it's replaced with a native <select> that calls the
 * same onValueChange.
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
        value: value ?? '',
        onChange: (e: { target: { value: string } }) => onValueChange?.(e.target.value),
      },
      // A native <select> with no matching option silently falls back to its
      // FIRST option, which would make an unset team indistinguishable from a
      // chosen one. The empty option gives the unset state something to select.
      h('option', { key: '__unset__', value: '' }, ''),
      children,
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => h('optgroup', {}, children),
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) =>
    h('option', { value }, children),
}))

import { IntegrationDetailView } from '../integration-detail-view'
import { TASK_DESTINATIONS_CHANGED } from '@/lib/tasks/destinations-events'

// ---- fetch fake ------------------------------------------------------------

interface FetchConfig {
  /** Saved task_sync_state.config returned by the settings GET. */
  config?: Record<string, unknown>
  teams?: Array<{ id: string; key: string | null; name: string }>
  organization?: { id: string; name: string } | null
  projects?: Array<{ id: string; name: string }>
  /** The config the PATCH echoes back — the server-derived state_map lives here. */
  patchConfig?: Record<string, unknown>
  /** Per-path override: a non-ok response body for a picker route. */
  fail?: { path: string; status: number; body: Record<string, unknown> }
  /** Fail the settings PATCH only (matching `fail` by prefix would kill the GET). */
  failPatch?: { status: number; body: Record<string, unknown> }
}

let patches: Array<Record<string, unknown>> = []
/** Every picker URL the view requested — the team a request is scoped to. */
let pickerUrls: string[] = []

const DEFAULT_TEAMS = [
  { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  { id: 'team-gro', key: 'GRO', name: 'Growth' },
]

/** A full four-bucket map, as the server derives it for a healthy team. */
const FULL_STATE_MAP = {
  not_started: { id: 'ls-todo', name: 'Todo' },
  in_progress: { id: 'ls-doing', name: 'In Progress' },
  done: { id: 'ls-done', name: 'Done' },
  canceled: { id: 'ls-cancel', name: 'Canceled' },
}

function installFetch(cfg: FetchConfig = {}) {
  patches = []
  pickerUrls = []
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)

      if (cfg.fail && url.startsWith(cfg.fail.path)) {
        return { ok: false, status: cfg.fail.status, json: async () => cfg.fail!.body }
      }

      if (url.startsWith('/api/oauth/status')) {
        return json({
          accounts: [
            {
              id: 'acct-1',
              provider: 'linear',
              capability: 'tasks',
              account_email: 'ada@example.com',
              display_name: null,
              color: '#5E6AD2',
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
      if (url.startsWith('/api/account/workspace/linear-settings')) {
        if (init?.method === 'PATCH') {
          patches.push(JSON.parse(String(init.body)))
          if (cfg.failPatch) {
            return { ok: false, status: cfg.failPatch.status, json: async () => cfg.failPatch!.body }
          }
          return json({
            connected: true,
            accountId: 'acct-1',
            config: cfg.patchConfig ?? {},
          })
        }
        return json({ connected: true, accountId: 'acct-1', config: cfg.config ?? {} })
      }
      if (url.startsWith('/api/account/linear/teams')) {
        return json({
          teams: cfg.teams ?? DEFAULT_TEAMS,
          organization:
            cfg.organization === undefined
              ? { id: 'org-1', name: 'Acme Inc' }
              : cfg.organization,
        })
      }
      if (url.startsWith('/api/account/linear/projects')) {
        pickerUrls.push(url)
        return json({
          projects: cfg.projects ?? [
            { id: 'proj-1', name: 'Q3 Platform' },
            { id: 'proj-2', name: 'Mobile' },
          ],
        })
      }
      return json({})
    }) as unknown as typeof fetch,
  )
}

const SAVED_DESTINATION = {
  organization_id: 'org-1',
  organization_name: 'Acme Inc',
  team_id: 'team-eng',
  team_key: 'ENG',
  team_name: 'Engineering',
  state_map: FULL_STATE_MAP,
}

// ---- harness ---------------------------------------------------------------

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

/** Drain until `done()` holds, rather than a fixed number of times. */
async function waitFor(done: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 25; i++) {
    if (done()) return
    await flush()
  }
  expect.fail(`timed out waiting for ${what}`)
}

async function waitForPatches(n: number): Promise<void> {
  await waitFor(() => patches.length >= n, `${n} PATCH(es)`)
}

async function mount() {
  await act(async () => {
    root.render(
      h(IntegrationDetailView, {
        provider: 'linear',
        capability: 'tasks',
        name: 'Linear',
        description: 'Push actions to Linear',
      }),
    )
  })
  // Mount fetches, then the project fetch they unlock.
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

/** [0] team, [1] project (only once a team is chosen). */
function selects(): HTMLSelectElement[] {
  return [...container.querySelectorAll('select')] as HTMLSelectElement[]
}

function text(): string {
  return container.textContent ?? ''
}

/**
 * The read-only state mapping as `{ bucketLabel: renderedValue }`.
 *
 * Read by ROW rather than off the whole container's text, because the bucket
 * LABEL and the state NAME both appear there and a substring assertion can't
 * tell "the canceled bucket maps to Done" apart from "the done bucket does".
 * Each row is `<span>label</span><span>value</span>`.
 */
function stageRows(): Record<string, string> {
  const heading = [...container.querySelectorAll('p')].find(
    (p) => p.textContent?.trim() === 'State for each stage',
  )
  const card = heading?.parentElement
  const out: Record<string, string> = {}
  const byLabel: Record<string, string> = {
    'Not started': 'not_started',
    'In progress': 'in_progress',
    Done: 'done',
    Canceled: 'canceled',
  }
  for (const row of card?.querySelectorAll('div > div') ?? []) {
    const spans = [...row.children] as HTMLElement[]
    if (spans.length < 2) continue
    const key = byLabel[spans[0].textContent?.trim() ?? '']
    if (key) out[key] = spans[1].textContent?.trim() ?? ''
  }
  return out
}

function button(label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  )
  expect(btn, `button "${label}"`).toBeTruthy()
  return btn as HTMLButtonElement
}

function hasButton(label: string): boolean {
  return [...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === label)
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

// ---- 1. the state map is derived, shown read-only --------------------------

describe('Linear state map — server-derived and read-only', () => {
  it('renders each bucket’s state NAME with no dropdown to change it', async () => {
    // The load-bearing difference from the Jira picker: there is nothing to
    // pick. `WorkflowState.type` decides the mapping, so offering a choice would
    // invite a configuration that contradicts the team it describes.
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    expect(text()).toContain('State for each stage')
    expect(stageRows()).toEqual({
      not_started: 'Todo',
      in_progress: 'In Progress',
      done: 'Done',
      canceled: 'Canceled',
    })

    // Exactly two selects: the team and the project. No bucket dropdowns.
    expect(selects()).toHaveLength(2)
  })

  it('WARNS on a bucket the team cannot express, instead of guessing one', async () => {
    // A team with no canceled-type state is ordinary, not broken — and the echo
    // declines that bucket rather than landing the action on "Done". Saying so
    // is the honest UI; showing a nearby state name would be a lie about what
    // happens next.
    installFetch({
      config: {
        ...SAVED_DESTINATION,
        state_map: {
          not_started: { id: 'ls-todo', name: 'Todo' },
          in_progress: { id: 'ls-doing', name: 'In Progress' },
          done: { id: 'ls-done', name: 'Done' },
          // canceled ABSENT — the team has no canceled-type state.
        },
      },
    })
    await mount()

    // The row's LABEL ("Canceled") stays either way — the bucket exists, the
    // team's state for it doesn't — so the assertion is on the row's VALUE.
    const rows = stageRows()
    expect(rows.not_started).toBe('Todo')
    expect(rows.done).toBe('Done')
    expect(rows.canceled).toContain('This team has no matching state')
    // …and nothing was substituted in from a neighbouring bucket.
    expect(rows.canceled).not.toContain('Done')
  })

  it('does not render the mapping at all before a team is chosen', async () => {
    installFetch({ config: {} })
    await mount()

    expect(text()).not.toContain('State for each stage')
  })

  it('ADOPTS the state_map the PATCH response carries', async () => {
    // The derived map exists ONLY in the save response — the client cannot
    // compute it. Ignoring it would leave the mapping blank until a reload.
    installFetch({
      config: {},
      patchConfig: { ...SAVED_DESTINATION, state_map: FULL_STATE_MAP },
    })
    await mount()

    selectOption(selects()[0], 'team-eng')
    await waitForPatches(1)
    await waitFor(() => text().includes('Todo'), 'the derived mapping to render')

    expect(text()).toContain('Todo')
    expect(text()).toContain('Canceled')
  })
})

// ---- 2. the organization travels with the team -----------------------------

describe('Linear team save', () => {
  it('sends the organization ALONGSIDE the team', async () => {
    // organization_id is what linear-apply-remote sanity-checks a webhook
    // delivery against, and the teams call is the only place the client sees it.
    installFetch({ config: {} })
    await mount()

    selectOption(selects()[0], 'team-eng')
    await waitForPatches(1)

    expect(patches[0]).toEqual({
      team_id: 'team-eng',
      team_key: 'ENG',
      team_name: 'Engineering',
      organization_id: 'org-1',
      organization_name: 'Acme Inc',
    })
  })

  it('still saves the team when the teams call reported NO organization', async () => {
    // The org pair is all-or-nothing server-side, so a half-known org must be
    // omitted entirely rather than sent with a placeholder.
    installFetch({ config: {}, organization: null })
    await mount()

    selectOption(selects()[0], 'team-eng')
    await waitForPatches(1)

    expect(patches[0]).toEqual({
      team_id: 'team-eng',
      team_key: 'ENG',
      team_name: 'Engineering',
    })
  })

  it('falls back to the team ID when the team reports no key', async () => {
    installFetch({
      config: {},
      teams: [{ id: 'team-x', key: null, name: 'Nameless' }],
    })
    await mount()

    selectOption(selects()[0], 'team-x')
    await waitForPatches(1)

    expect(patches[0]).toMatchObject({ team_id: 'team-x', team_key: 'team-x' })
  })

  it('does NOT re-send the project when the team is unchanged', async () => {
    installFetch({ config: { ...SAVED_DESTINATION, project_id: 'proj-1', project_name: 'Q3' } })
    await mount()

    selectOption(selects()[0], 'team-eng')
    await waitForPatches(1)

    expect(patches[0]).not.toHaveProperty('project_id')
  })
})

// ---- 3. switching teams drops the project ----------------------------------

describe('Linear team switch', () => {
  it('drops the project from the local state on a team switch', async () => {
    // A project belongs to the teams it is shared with. Keeping the old one
    // visible under the new team would show a destination that cannot receive
    // an issue — and the server drops it too, so the optimistic state would be
    // lying about what was stored.
    installFetch({
      config: { ...SAVED_DESTINATION, project_id: 'proj-1', project_name: 'Q3 Platform' },
      patchConfig: {
        organization_id: 'org-1',
        organization_name: 'Acme Inc',
        team_id: 'team-gro',
        team_key: 'GRO',
        team_name: 'Growth',
        state_map: FULL_STATE_MAP,
      },
    })
    await mount()
    expect(text()).toContain('Q3 Platform')

    selectOption(selects()[0], 'team-gro')
    await waitForPatches(1)
    await waitFor(() => text().includes('Growth'), 'the new team to render')

    // The PATCH names only the new team; `state_map` is NEVER sent (the route
    // rejects it as a key and derives it itself).
    expect(patches[0]).toEqual({
      team_id: 'team-gro',
      team_key: 'GRO',
      team_name: 'Growth',
      organization_id: 'org-1',
      organization_name: 'Acme Inc',
    })
    expect(patches[0]).not.toHaveProperty('state_map')
  })

  it('re-scopes the project picker to the NEW team', async () => {
    installFetch({ config: SAVED_DESTINATION })
    await mount()
    expect(pickerUrls.some((u) => u.includes('teamId=team-eng'))).toBe(true)

    installFetch({ config: SAVED_DESTINATION })
    // Re-installing clears pickerUrls; re-mount against the switched team.
    installFetch({
      config: { ...SAVED_DESTINATION, team_id: 'team-gro', team_name: 'Growth' },
    })
    await mount()

    expect(pickerUrls.every((u) => u.includes('teamId=team-gro'))).toBe(true)
  })
})

// ---- 4. the project is optional --------------------------------------------

describe('Linear project — optional, and "no project" is a real destination', () => {
  it('sends the project pair when one is chosen', async () => {
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    selectOption(selects()[1], 'proj-1')
    await waitForPatches(1)

    expect(patches[0]).toEqual({ project_id: 'proj-1', project_name: 'Q3 Platform' })
  })

  it('sends the route’s `{ project_id: null }` clear shape for "No project"', async () => {
    // Not a teardown: the team survives, which is why this cannot be expressed
    // by simply omitting the keys (every other PATCH merges).
    installFetch({
      config: { ...SAVED_DESTINATION, project_id: 'proj-1', project_name: 'Q3 Platform' },
    })
    await mount()

    selectOption(selects()[1], '__no_project__')
    await waitForPatches(1)

    expect(patches[0]).toEqual({ project_id: null })
  })

  it('offers no project picker until a team is chosen', async () => {
    installFetch({ config: {} })
    await mount()

    expect(selects()).toHaveLength(1)
  })
})

// ---- 5. clearing the destination -------------------------------------------

describe('Linear clear destination', () => {
  it('sends `{ team_id: null }` alone — the route’s explicit clear shape', async () => {
    installFetch({ config: SAVED_DESTINATION, patchConfig: { organization_id: 'org-1' } })
    await mount()

    button('Clear destination').click()
    await waitForPatches(1)

    expect(patches[0]).toEqual({ team_id: null })
  })

  it('offers no Clear until something is set', async () => {
    installFetch({ config: {} })
    await mount()
    expect(hasButton('Clear destination')).toBe(false)
  })
})

// ---- 6. the attribution toggle ---------------------------------------------

describe('Linear attribution toggle', () => {
  it('rides the same PATCH, on its own', async () => {
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    const toggle = container.querySelector(
      '[aria-label="Include a “Pushed from Native Intelligence” link on pushed tasks"]',
    ) as HTMLElement
    expect(toggle).toBeTruthy()
    toggle.click()
    await waitForPatches(1)

    expect(patches[0]).toEqual({ include_dial8_attribution: false })
  })

  it('is available BEFORE a destination is picked — it is provider-level', async () => {
    installFetch({ config: {} })
    await mount()

    const toggle = container.querySelector(
      '[aria-label="Include a “Pushed from Native Intelligence” link on pushed tasks"]',
    ) as HTMLElement
    expect(toggle).toBeTruthy()
    expect(toggle.getAttribute('data-disabled')).toBeNull()
  })

  it('reads an ABSENT flag as ON (the server default)', async () => {
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    const toggle = container.querySelector(
      '[aria-label="Include a “Pushed from Native Intelligence” link on pushed tasks"]',
    ) as HTMLElement
    expect(toggle.getAttribute('data-state')).toBe('checked')
  })
})

// ---- 7. the freshness announcement -----------------------------------------

describe('Linear save funnel — the destination-changed announcement', () => {
  it('announces after a successful PATCH so the push menu re-reads', async () => {
    // The freshness fix (PR #282): without this the "Push to…" menu keeps
    // serving its cached "configure in settings" answer for a whole TTL, with
    // the settings overlay open right on top of it.
    installFetch({ config: {} })
    await mount()

    let announced = 0
    const onChanged = () => {
      announced++
    }
    window.addEventListener(TASK_DESTINATIONS_CHANGED, onChanged)

    selectOption(selects()[0], 'team-eng')
    await waitForPatches(1)
    await waitFor(() => announced > 0, 'the destinations-changed announcement')

    window.removeEventListener(TASK_DESTINATIONS_CHANGED, onChanged)
    expect(announced).toBeGreaterThan(0)
  })

  it('does NOT announce when the PATCH failed', async () => {
    installFetch({ config: {}, failPatch: { status: 500, body: { error: 'boom' } } })
    await mount()

    let announced = 0
    const onChanged = () => {
      announced++
    }
    window.addEventListener(TASK_DESTINATIONS_CHANGED, onChanged)

    selectOption(selects()[0], 'team-eng')
    await waitForPatches(1)
    await waitFor(() => text().includes('boom'), 'the save error to render')

    window.removeEventListener(TASK_DESTINATIONS_CHANGED, onChanged)
    expect(announced).toBe(0)
  })

  it('REVERTS the optimistic config when the PATCH fails', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      failPatch: { status: 500, body: { error: 'boom' } },
    })
    await mount()

    selectOption(selects()[0], 'team-gro')
    await waitForPatches(1)
    await waitFor(() => text().includes('boom'), 'the save error to render')

    // Still on Engineering — the save didn't land, so the UI must not claim it.
    expect(text()).toContain('Engineering')
  })

  it('raises the RECONNECT banner when the save could not verify the team', async () => {
    // The settings route answers `reconnect_required` and saves NOTHING when the
    // state-map derivation hits a rejected token. Retrying will not help, so the
    // banner is the honest surface rather than an inline "failed to save".
    installFetch({
      config: {},
      failPatch: { status: 400, body: { error: 'Reconnect Linear', code: 'reconnect_required' } },
    })
    await mount()

    selectOption(selects()[0], 'team-eng')
    await waitForPatches(1)
    await waitFor(
      () => text().includes('Reconnect Linear to manage the destination'),
      'the reconnect banner',
    )

    expect(text()).toContain('Reconnect Linear to manage the destination')
  })
})

// ---- 8. picker failures are classified -------------------------------------

describe('Linear picker failures', () => {
  it('replaces the pickers with the reconnect banner on a dead token', async () => {
    // Falling back to an empty team list is indistinguishable from "you have no
    // teams" — which is both wrong and unactionable.
    installFetch({
      config: {},
      fail: {
        path: '/api/account/linear/teams',
        status: 400,
        body: { error: 'Reconnect Linear to continue', code: 'reconnect_required' },
      },
    })
    await mount()

    expect(text()).toContain('Reconnect Linear to manage the destination')
    expect(selects()).toHaveLength(0)
  })

  it('treats `not_connected` the same way — the user’s fix is identical', async () => {
    installFetch({
      config: {},
      fail: {
        path: '/api/account/linear/teams',
        status: 400,
        body: { error: 'Linear is not connected', code: 'not_connected' },
      },
    })
    await mount()

    expect(text()).toContain('Reconnect Linear to manage the destination')
  })

  it('shows a retryable inline error for anything else', async () => {
    installFetch({
      config: {},
      fail: { path: '/api/account/linear/teams', status: 500, body: { error: 'Linear is down' } },
    })
    await mount()

    expect(text()).toContain('Linear is down')
    expect(hasButton('Retry')).toBe(true)
    // NOT the reconnect banner — reconnecting would not fix a 5xx.
    expect(text()).not.toContain('Reconnect Linear to manage the destination')
  })

  it('re-runs the pickers when Retry is pressed', async () => {
    installFetch({
      config: {},
      fail: { path: '/api/account/linear/teams', status: 500, body: { error: 'Linear is down' } },
    })
    await mount()

    const before = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    await act(async () => {
      button('Retry').click()
    })
    await flush()

    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(
      before,
    )
  })
})
