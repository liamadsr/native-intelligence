// @vitest-environment jsdom
/**
 * The stale-failure guard, as the CASCADE effects see it.
 *
 * `use-destination-picker.test.tsx` proves the mechanism on the hook's own load
 * effect: a superseded run must classify nothing, because the two failure
 * setters live inside `readPicker` where the run's `cancelled` flag was never in
 * scope. The threaded `isCancelled` accessor closed that for the load effect.
 *
 * These are the OTHER five call sites — the per-provider cascade effects in
 * integration-detail-view.tsx, which each already had a `cancelled` flag and
 * each dropped a stale SUCCESS with it while still letting a stale FAILURE
 * through. They are not reachable from the hook's suite: the cascades live in
 * the component, keyed off derived ids and a search box, so they need the full
 * component and the three destination suites' harness.
 *
 * The scenario is the one a user actually hits, and it is worse here than on the
 * load effect: no Retry click is required. Every one of these effects re-runs on
 * a plain state change — a keystroke in the project search, a different team —
 * so two runs overlapping is the NORMAL case, not a race you have to provoke.
 * Type fast enough and the request for "En" is still open when the one for "Eng"
 * has already rendered its projects; when "En" finally 500s it paints an error
 * over a list that is right there on screen.
 *
 * Each test gates the FIRST request to a cascade route, lets a second (fresh)
 * run answer 200, and only then releases the first as a failure. The assertion
 * is that the failure changed nothing: no inline error, no reconnect banner, and
 * the fresh options still rendered.
 *
 * Radix's Select can't be driven in jsdom (it needs pointer-capture APIs jsdom
 * doesn't implement), so it's replaced with a native <select> that calls the
 * same onValueChange — the same substitution the three destination suites make.
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
      // FIRST option, which would make an unset value indistinguishable from a
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

// ---- gate ------------------------------------------------------------------

/** A response the fetch fake can hand back. */
type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> }

const ok = (body: unknown): FakeResponse => ({ ok: true, status: 200, json: async () => body })

/**
 * Holds the FIRST request to `path` open until released, then answers `stale`.
 * Every later request to that path answers `fresh` immediately.
 *
 * This is the whole scenario in one object: the superseded run and the run that
 * supersedes it differ only in WHEN they resolve, which is exactly how the real
 * thing goes wrong.
 */
function makeGate(path: string, stale: () => Promise<FakeResponse>, fresh: unknown) {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let calls = 0

  return {
    path,
    /** True once the fresh (second) run has been issued — what `waitFor` waits on. */
    get superseded() {
      return calls > 1
    },
    async handle(): Promise<FakeResponse> {
      if (calls++ === 0) {
        await gate
        return stale()
      }
      return ok(fresh)
    },
    release: () => release(),
  }
}

type Gate = ReturnType<typeof makeGate>

const reconnectBody = (error: string) => async () => ({
  ok: false,
  status: 400,
  json: async () => ({ error, code: 'reconnect_required' }),
})

const serverErrorBody = (error: string) => async () => ({
  ok: false,
  status: 500,
  json: async () => ({ error }),
})

// ---- fetch fake ------------------------------------------------------------

interface FetchConfig {
  provider: 'asana' | 'jira' | 'linear'
  /** Saved task_sync_state.config returned by the settings GET. */
  config: Record<string, unknown>
  /** The one cascade route whose first request is held open. */
  gate?: Gate
}

function installFetch(cfg: FetchConfig) {
  const { provider } = cfg

  const colors = { asana: '#F06A6A', jira: '#0052CC', linear: '#5E6AD2' } as const

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)

      if (cfg.gate && url.startsWith(cfg.gate.path)) return cfg.gate.handle()

      if (url.startsWith('/api/oauth/status')) {
        return ok({
          accounts: [
            {
              id: 'acct-1',
              provider,
              capability: 'tasks',
              account_email: 'ada@example.com',
              display_name: null,
              color: colors[provider],
              is_enabled: true,
              is_primary: true,
              workspace_ids: ['ws-1'],
              scopes: [],
            },
          ],
        })
      }
      if (url.startsWith('/api/account/workspace/list')) {
        return ok({ workspaces: [{ id: 'ws-1', name: 'Acme' }] })
      }
      if (url.startsWith(`/api/account/workspace/${provider}-settings`)) {
        return ok({ connected: true, accountId: 'acct-1', config: cfg.config })
      }

      // ---- Asana pickers
      if (url.startsWith('/api/account/asana/workspaces')) {
        return ok({ workspaces: [{ gid: 'aw-1', name: 'Acme' }] })
      }
      if (url.startsWith('/api/account/asana/projects')) {
        return ok({
          projects: [
            { gid: 'proj-1', name: 'Engineering' },
            { gid: 'proj-2', name: 'Growth' },
          ],
        })
      }
      if (url.startsWith('/api/account/asana/sections')) {
        return ok({
          sections: [
            { gid: 's-todo', name: 'To Do' },
            { gid: 's-doing', name: 'In Progress' },
            { gid: 's-done', name: 'Done' },
            { gid: 's-cancelled', name: 'Cancelled' },
          ],
        })
      }

      // ---- Jira pickers
      if (url.startsWith('/api/account/jira/sites')) {
        return ok({ sites: [{ id: 'cafe0001', name: 'Acme', url: 'https://acme.atlassian.net' }] })
      }
      if (url.startsWith('/api/account/jira/projects')) {
        return ok({
          projects: [
            { id: '10000', key: 'ENG', name: 'Engineering' },
            { id: '20000', key: 'GRO', name: 'Growth' },
          ],
        })
      }
      if (url.startsWith('/api/account/jira/issue-types')) {
        return ok({ issueTypes: [{ id: '10001', name: 'Task' }] })
      }
      if (url.startsWith('/api/account/jira/statuses')) {
        return ok({
          statuses: [
            { id: 's-todo', name: 'To Do', category: 'new' },
            { id: 's-done', name: 'Done', category: 'done' },
          ],
        })
      }

      // ---- Linear pickers
      if (url.startsWith('/api/account/linear/teams')) {
        return ok({
          teams: [
            { id: 'team-eng', key: 'ENG', name: 'Engineering' },
            { id: 'team-gro', key: 'GRO', name: 'Growth' },
          ],
          organization: { id: 'org-1', name: 'Acme Inc' },
        })
      }
      if (url.startsWith('/api/account/linear/projects')) {
        return ok({
          projects: [
            { id: 'proj-1', name: 'Q3 Platform' },
            { id: 'proj-2', name: 'Mobile' },
          ],
        })
      }

      return ok({})
    }) as unknown as typeof fetch,
  )
}

const ASANA_DESTINATION = {
  asana_workspace_gid: 'aw-1',
  asana_workspace_name: 'Acme',
  project_gid: 'proj-1',
  project_name: 'Engineering',
}

const JIRA_SITE = {
  cloud_id: 'cafe0001',
  site_name: 'Acme',
  site_url: 'https://acme.atlassian.net',
}

const JIRA_DESTINATION = {
  ...JIRA_SITE,
  project_id: '10000',
  project_key: 'ENG',
  project_name: 'Engineering',
  issue_type_id: '10001',
  issue_type_name: 'Task',
}

const LINEAR_DESTINATION = {
  organization_id: 'org-1',
  organization_name: 'Acme Inc',
  team_id: 'team-eng',
  team_key: 'ENG',
  team_name: 'Engineering',
}

// ---- harness ---------------------------------------------------------------

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

/**
 * Drain until `done()` holds, rather than a fixed number of times — the same
 * reason the Jira and Linear suites do: a fixed-count drain that happens to be
 * one tick short fails for reasons unrelated to the code under test. The cap
 * only exists so a genuine failure fails fast instead of hanging the suite.
 */
async function waitFor(done: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 25; i++) {
    if (done()) return
    await flush()
  }
  expect.fail(`timed out waiting for ${what}`)
}

async function mount(provider: 'asana' | 'jira' | 'linear', name: string) {
  await act(async () => {
    root.render(
      h(IntegrationDetailView, {
        provider,
        capability: 'tasks',
        name,
        description: `Push actions to ${name}`,
      }),
    )
  })
  // Mount fetches, then the cascade fetches they unlock.
  await flush()
  await flush()
  await flush()
}

/** Release the held-open stale request and let its rejection settle. */
async function releaseStale(gate: Gate) {
  await act(async () => {
    gate.release()
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
  await flush()
}

function text(): string {
  return container.textContent ?? ''
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

/** Type into the project search box the way React's change handler will see it. */
function typeSearch(value: string) {
  const input = container.querySelector(
    'input[placeholder="Search projects..."]',
  ) as HTMLInputElement | null
  expect(input, 'project search box').toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!
  setter.call(input, value)
  input!.dispatchEvent(new Event('input', { bubbles: true }))
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

// ---- Asana: the keystroke scenario -----------------------------------------

/**
 * The purest form of the bug, because it needs no failure to be RETRIED and no
 * button to be clicked — just two keystrokes and an unlucky ordering.
 *
 * The project effect re-runs on every keystroke (it hits Asana's typeahead), so
 * the request for the shorter query is routinely still open when the longer
 * one's answer has already rendered. The user sees the right projects and then,
 * a moment later, an error about them.
 */
describe('Asana projects — a stale keystroke cannot break the list it lost to', () => {
  it('drops a stale 5xx that resolves after a newer keystroke rendered projects', async () => {
    const gate = makeGate(
      '/api/account/asana/projects',
      serverErrorBody('Failed to list Asana projects'),
      { projects: [{ gid: 'proj-9', name: 'Platform' }] },
    )
    installFetch({ provider: 'asana', config: ASANA_DESTINATION, gate })
    await mount('asana', 'Asana')

    // Second keystroke supersedes the first request, which is still held open.
    await act(async () => typeSearch('Plat'))
    await waitFor(() => gate.superseded, 'the second projects request')
    await waitFor(() => text().includes('Platform'), 'the fresh project list')

    await releaseStale(gate)

    // The stale answer is about a query the user has already moved on from.
    expect(text()).not.toContain('Failed to list Asana projects')
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Retry'),
    ).toBe(false)
    expect(text()).toContain('Platform')
  })

  it('drops a stale reconnect code too — the account is demonstrably working', async () => {
    const gate = makeGate(
      '/api/account/asana/projects',
      reconnectBody('Reconnect Asana to continue'),
      { projects: [{ gid: 'proj-9', name: 'Platform' }] },
    )
    installFetch({ provider: 'asana', config: ASANA_DESTINATION, gate })
    await mount('asana', 'Asana')

    await act(async () => typeSearch('Plat'))
    await waitFor(() => gate.superseded, 'the second projects request')
    await waitFor(() => text().includes('Platform'), 'the fresh project list')

    await releaseStale(gate)

    // The banner REPLACES the pickers wholesale, so this is the loudest possible
    // way to be wrong about a connection the newer request just used fine.
    expect(text()).not.toContain('Reconnect Asana to manage the destination')
    expect(text()).toContain('Platform')
  })
})

// ---- Asana: the sections cascade -------------------------------------------

describe('Asana sections — a stale failure cannot break the buckets it lost to', () => {
  it('drops a stale 5xx that resolves after a newer project rendered sections', async () => {
    const gate = makeGate(
      '/api/account/asana/sections',
      serverErrorBody('Failed to list Asana sections'),
      { sections: [{ gid: 's-fresh', name: 'Fresh Section' }] },
    )
    installFetch({ provider: 'asana', config: ASANA_DESTINATION, gate })
    await mount('asana', 'Asana')

    // Switching projects re-runs the sections effect with the first still open.
    const growth = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Growth',
    ) as HTMLButtonElement
    expect(growth, 'the Growth project button').toBeTruthy()
    await act(async () => growth.click())
    await waitFor(() => gate.superseded, 'the second sections request')
    await waitFor(() => text().includes('Fresh Section'), 'the fresh section list')

    await releaseStale(gate)

    expect(text()).not.toContain('Failed to list Asana sections')
    expect(text()).toContain('Fresh Section')
  })
})

// ---- Jira -------------------------------------------------------------------

describe('Jira projects — a stale failure cannot break the list it lost to', () => {
  it('drops a stale 5xx that resolves after a newer keystroke rendered projects', async () => {
    const gate = makeGate(
      '/api/account/jira/projects',
      serverErrorBody('Failed to list Jira projects'),
      { projects: [{ id: '90000', key: 'PLAT', name: 'Platform' }] },
    )
    installFetch({ provider: 'jira', config: JIRA_DESTINATION, gate })
    await mount('jira', 'Jira')

    await act(async () => typeSearch('Plat'))
    await waitFor(() => gate.superseded, 'the second projects request')
    await waitFor(() => text().includes('Platform'), 'the fresh project list')

    await releaseStale(gate)

    expect(text()).not.toContain('Failed to list Jira projects')
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Retry'),
    ).toBe(false)
    expect(text()).toContain('Platform')
  })

  it('drops a stale reconnect code from the issue-types leg of the pair', async () => {
    // Issue types and statuses reload TOGETHER off the same effect, so this also
    // covers the sibling call site: the statuses leg succeeded either way, and a
    // stale issue-types failure would have banner-ed over it.
    const gate = makeGate(
      '/api/account/jira/issue-types',
      reconnectBody('Reconnect Jira to continue'),
      { issueTypes: [{ id: '99999', name: 'Fresh Type' }] },
    )
    installFetch({ provider: 'jira', config: JIRA_DESTINATION, gate })
    await mount('jira', 'Jira')

    // Switching projects re-runs the issue-type/status effect.
    const growth = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Growth'),
    ) as HTMLButtonElement
    expect(growth, 'the Growth project button').toBeTruthy()
    await act(async () => growth.click())
    await waitFor(() => gate.superseded, 'the second issue-types request')
    await waitFor(() => text().includes('Fresh Type'), 'the fresh issue types')

    await releaseStale(gate)

    expect(text()).not.toContain('Reconnect Jira to manage the destination')
    expect(text()).toContain('Fresh Type')
  })
})

// ---- Linear -----------------------------------------------------------------

describe('Linear projects — a stale failure cannot break the list it lost to', () => {
  it('drops a stale 5xx that resolves after a newer team rendered projects', async () => {
    const gate = makeGate(
      '/api/account/linear/projects',
      serverErrorBody("Failed to list the team's projects"),
      { projects: [{ id: 'proj-9', name: 'Fresh Project' }] },
    )
    installFetch({ provider: 'linear', config: LINEAR_DESTINATION, gate })
    await mount('linear', 'Linear')

    // Switching teams re-runs the project effect with the first still open.
    const teamSelect = container.querySelector('select') as HTMLSelectElement
    expect(teamSelect, 'the team picker').toBeTruthy()
    await act(async () => selectOption(teamSelect, 'team-gro'))
    await waitFor(() => gate.superseded, 'the second projects request')
    await waitFor(() => text().includes('Fresh Project'), 'the fresh project list')

    await releaseStale(gate)

    expect(text()).not.toContain("Failed to list the team's projects")
    expect(text()).toContain('Fresh Project')
  })

  it('drops a stale reconnect code that resolves after a newer team succeeded', async () => {
    const gate = makeGate(
      '/api/account/linear/projects',
      reconnectBody('Reconnect Linear to continue'),
      { projects: [{ id: 'proj-9', name: 'Fresh Project' }] },
    )
    installFetch({ provider: 'linear', config: LINEAR_DESTINATION, gate })
    await mount('linear', 'Linear')

    const teamSelect = container.querySelector('select') as HTMLSelectElement
    await act(async () => selectOption(teamSelect, 'team-gro'))
    await waitFor(() => gate.superseded, 'the second projects request')
    await waitFor(() => text().includes('Fresh Project'), 'the fresh project list')

    await releaseStale(gate)

    expect(text()).not.toContain('Reconnect Linear to manage the destination')
    expect(text()).toContain('Fresh Project')
  })
})
