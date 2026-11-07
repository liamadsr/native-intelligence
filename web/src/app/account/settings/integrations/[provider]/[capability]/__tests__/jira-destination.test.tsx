// @vitest-environment jsdom
/**
 * The Jira destination picker in IntegrationDetailView — the behaviours that
 * are invisible from the component's own state and only show up in the PATCH
 * body it sends (or in what it renders when a fetch fails):
 *
 * 1. an unmapped bucket is shown as "Automatic (by category)" with a HINT of
 *    what that resolves to — never as a pre-selected status. Asana's picker
 *    pre-selects a guess, which is safe there because an unmapped bucket does
 *    nothing; here an unmapped bucket still transitions the issue, so a guessed
 *    selection would misrepresent both what is stored and what will happen.
 * 2. switching projects clears the status map AND the issue type. Statuses
 *    belong to the old project's workflow and, in a team-managed project, so do
 *    the issue-type ids — carrying either across produces pushes that 400.
 * 3. the site travels with the project (the API refuses a project it cannot
 *    address), and "Clear destination" KEEPS the site.
 * 4. every picker fetch failure is classified rather than collapsed to an empty
 *    array, so a dead token explains itself instead of rendering four empty
 *    dropdowns.
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
      // Radix renders "nothing selected" as a placeholder; a native <select>
      // with no matching option silently falls back to its FIRST option, which
      // would make an unset issue type indistinguishable from a chosen one. The
      // empty option gives the unset state something to select.
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
  /** Atlassian sites the account can reach. Defaults to one. */
  sites?: Array<{ id: string; name: string | null; url: string | null }>
  statuses?: Array<{ id: string; name: string; category: string | null }>
  issueTypes?: Array<{ id: string; name: string }>
  /** Per-path override: a non-ok response body for a picker route. */
  fail?: { path: string; status: number; body: Record<string, unknown> }
  /** Fail the settings PATCH only (matching `fail` by prefix would kill the GET). */
  failPatch?: { status: number; body: Record<string, unknown> }
}

let patches: Array<Record<string, unknown>> = []
/** Every picker URL the view requested — the site a request is scoped to. */
let pickerUrls: string[] = []

const DEFAULT_STATUSES = [
  { id: 's-todo', name: 'To Do', category: 'new' },
  { id: 's-doing', name: 'In Progress', category: 'indeterminate' },
  { id: 's-done', name: 'Done', category: 'done' },
  { id: 's-wontdo', name: "Won't Do", category: 'done' },
]

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
              provider: 'jira',
              capability: 'tasks',
              account_email: 'ada@example.com',
              display_name: null,
              color: '#0052CC',
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
      if (url.startsWith('/api/account/workspace/jira-settings')) {
        if (init?.method === 'PATCH') {
          patches.push(JSON.parse(String(init.body)))
          if (cfg.failPatch) {
            return { ok: false, status: cfg.failPatch.status, json: async () => cfg.failPatch!.body }
          }
          return json({ connected: true, accountId: 'acct-1', config: {} })
        }
        return json({ connected: true, accountId: 'acct-1', config: cfg.config ?? {} })
      }
      if (url.startsWith('/api/account/jira/sites')) {
        return json({
          sites: cfg.sites ?? [{ id: 'cafe0001', name: 'Acme', url: 'https://acme.atlassian.net' }],
        })
      }
      if (url.startsWith('/api/account/jira/projects')) {
        pickerUrls.push(url)
        return json({
          projects: [
            { id: '10000', key: 'ENG', name: 'Engineering' },
            { id: '20000', key: 'GRO', name: 'Growth' },
          ],
        })
      }
      if (url.startsWith('/api/account/jira/issue-types')) {
        pickerUrls.push(url)
        return json({
          issueTypes: cfg.issueTypes ?? [
            { id: '10001', name: 'Task' },
            { id: '10005', name: 'Bug' },
          ],
        })
      }
      if (url.startsWith('/api/account/jira/statuses')) {
        pickerUrls.push(url)
        return json({ statuses: cfg.statuses ?? DEFAULT_STATUSES })
      }
      return json({})
    }) as unknown as typeof fetch,
  )
}

const SITE = {
  cloud_id: 'cafe0001',
  site_name: 'Acme',
  site_url: 'https://acme.atlassian.net',
}

const SAVED_DESTINATION = {
  ...SITE,
  project_id: '10000',
  project_key: 'ENG',
  project_name: 'Engineering',
  issue_type_id: '10001',
  issue_type_name: 'Task',
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
 * Drain until `done()` holds, rather than a fixed number of times.
 *
 * `flush()` is a fixed-count microtask drain, and a chain of fetches that
 * happens to need one tick more than it gives — a slow, contended CI box is
 * exactly where that shows up — makes an assertion fail for reasons that have
 * nothing to do with the code under test. Waiting on the CONDITION removes the
 * race; the iteration cap only exists so a genuine failure still fails fast
 * instead of hanging the suite.
 */
async function waitFor(done: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 25; i++) {
    if (done()) return
    await flush()
  }
  expect.fail(`timed out waiting for ${what}`)
}

/** Wait until the component has sent `n` PATCHes. */
async function waitForPatches(n: number): Promise<void> {
  await waitFor(() => patches.length >= n, `${n} PATCH(es)`)
}

async function mount() {
  await act(async () => {
    root.render(
      h(IntegrationDetailView, {
        provider: 'jira',
        capability: 'tasks',
        name: 'Jira',
        description: 'Push actions to Jira',
      }),
    )
  })
  // Mount fetches, then the project/issue-type/status fetches they unlock.
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

/** [0] site, [1] issue type, [2..5] the four lifecycle buckets. */
function selects(): HTMLSelectElement[] {
  return [...container.querySelectorAll('select')] as HTMLSelectElement[]
}

function bucketSelects(): HTMLSelectElement[] {
  return selects().slice(2)
}

/**
 * The "→ X" fallback hints, in LIFECYCLE_BUCKETS order (not started, in
 * progress, done, canceled). Only automatic buckets render one, so this is
 * index-aligned with the buckets only while none of them is mapped.
 */
function autoHints(): string[] {
  return [...container.querySelectorAll('span')]
    .map((s) => s.textContent?.trim() ?? '')
    .filter((t) => t.startsWith('→'))
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

// ---- 1. the status map: automatic is a fallback, not a guess ---------------

describe('Jira status map — "Automatic" is shown as a fallback, never as a pick', () => {
  it('renders every unmapped bucket as Automatic, not as a guessed status', async () => {
    // The load-bearing difference from the Asana picker: an unmapped Jira bucket
    // STILL transitions the issue (by statusCategory), so pre-selecting a guess
    // would claim a choice the user never made and might not match the fallback.
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    const buckets = bucketSelects()
    expect(buckets).toHaveLength(4)
    for (const select of buckets) expect(select.value).toBe('__auto__')
  })

  it('names what Automatic resolves to, using the echo’s OWN rules', async () => {
    // The hint mirrors selectTransition: category match, and within the done
    // category a cancel-ish NAME is what separates canceled from done.
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    const text = container.textContent || ''
    expect(text).toContain('→ To Do')
    expect(text).toContain('→ In Progress')
    expect(text).toContain('→ Done')
    expect(text).toContain("→ Won't Do")
  })

  /**
   * REGRESSION (round-2 audit, echo issue 3): the hint claims to mirror
   * selectTransition exactly, and reproduced tier (b) — a cancel-named status
   * wins the `canceled` bucket — but not tier (c), which never lands the `done`
   * bucket on a cancel-named status. Status order comes from the workflow
   * definition and is arbitrary, so a project that happens to list "Won't Do"
   * first told the user Done would land on "Won't Do" while the echo would skip
   * it and pick "Done". A hint that disagrees with the behaviour it describes is
   * worse than no hint.
   */
  it('never names a cancel-ish status for the DONE bucket, whatever the order', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      statuses: [
        { id: 's-todo', name: 'To Do', category: 'new' },
        { id: 's-doing', name: 'In Progress', category: 'indeterminate' },
        // The done category, cancellation FIRST.
        { id: 's-wontdo', name: "Won't Do", category: 'done' },
        { id: 's-done', name: 'Done', category: 'done' },
      ],
    })
    await mount()

    expect(autoHints()).toEqual(['→ To Do', '→ In Progress', '→ Done', "→ Won't Do"])
  })

  it('leaves the DONE hint empty when every done status is cancel-named', async () => {
    // Same rule at its limit: the echo would find no candidate either (tier (c)
    // excludes them all), so naming one would be a promise it cannot keep.
    installFetch({
      config: SAVED_DESTINATION,
      statuses: [
        { id: 's-todo', name: 'To Do', category: 'new' },
        { id: 's-wontdo', name: "Won't Do", category: 'done' },
      ],
    })
    await mount()

    expect(autoHints()).toEqual(['→ To Do', "→ Won't Do"])
  })

  it('persists ONLY the bucket the user changed', async () => {
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    await act(async () => selectOption(bucketSelects()[2], 's-done'))
    await flush()

    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual({ status_map: { done: 's-done' } })
  })

  it('merges an explicit pick onto the SAVED map, keeping the other buckets', async () => {
    installFetch({
      config: {
        ...SAVED_DESTINATION,
        status_map: { not_started: 's-todo', in_progress: null, done: null, canceled: null },
      },
    })
    await mount()

    await act(async () => selectOption(bucketSelects()[2], 's-done'))
    await flush()

    expect(patches[0]).toEqual({
      status_map: { not_started: 's-todo', in_progress: null, done: 's-done', canceled: null },
    })
  })

  it('sends null (not the sentinel) when a bucket is set back to Automatic', async () => {
    installFetch({
      config: {
        ...SAVED_DESTINATION,
        status_map: { not_started: 's-todo', in_progress: null, done: 's-done', canceled: null },
      },
    })
    await mount()

    await act(async () => selectOption(bucketSelects()[2], '__auto__'))
    await flush()

    expect(patches[0]).toEqual({
      status_map: { not_started: 's-todo', in_progress: null, done: null, canceled: null },
    })
  })

  it('drops the hint for a bucket the user HAS mapped', async () => {
    installFetch({
      config: {
        ...SAVED_DESTINATION,
        status_map: { not_started: null, in_progress: null, done: 's-done', canceled: null },
      },
    })
    await mount()

    expect(bucketSelects()[2].value).toBe('s-done')
    // Only the three still-automatic buckets explain themselves.
    expect(container.textContent).not.toContain('→ Done')
    expect(container.textContent).toContain('→ To Do')
  })
})

// ---- 2. project switch ------------------------------------------------------

describe('Jira project switch — project-scoped ids are cleared', () => {
  it('sends the SITE with the project — the API refuses a project it can’t address', async () => {
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    await act(async () => button('GROGrowth').click())
    await flush()

    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      cloud_id: 'cafe0001',
      site_name: 'Acme',
      site_url: 'https://acme.atlassian.net',
      project_id: '20000',
      project_key: 'GRO',
      project_name: 'Growth',
    })
  })

  it('sends an explicit all-null status_map when the project actually changes', async () => {
    installFetch({
      config: {
        ...SAVED_DESTINATION,
        status_map: { not_started: 's-todo', in_progress: null, done: 's-done', canceled: null },
      },
    })
    await mount()

    await act(async () => button('GROGrowth').click())
    await flush()

    expect(patches[0]).toMatchObject({
      status_map: { not_started: null, in_progress: null, done: null, canceled: null },
    })
  })

  it('drops the ISSUE TYPE from the local state on a switch', async () => {
    // A team-managed project owns its own issue-type ids, so carrying '10001'
    // across doesn't produce a wrong type — it produces a push that 400s. The
    // route enforces this too; the optimistic state has to agree or the UI shows
    // a type that is no longer stored.
    installFetch({ config: SAVED_DESTINATION })
    await mount()
    expect(selects()[1].value).toBe('10001')

    await act(async () => button('GROGrowth').click())
    await flush()

    expect(selects()[1].value).toBe('')
  })

  it('leaves everything alone when the user re-picks the SAME project', async () => {
    installFetch({
      config: {
        ...SAVED_DESTINATION,
        status_map: { not_started: 's-todo', in_progress: null, done: 's-done', canceled: null },
      },
    })
    await mount()

    await act(async () => button('ENGEngineering').click())
    await flush()

    expect(patches).toHaveLength(1)
    expect(patches[0]).not.toHaveProperty('status_map')
    expect(selects()[1].value).toBe('10001')
  })
})

// ---- 2b. the SITE switch ----------------------------------------------------

/**
 * REGRESSION (review findings: "site switch with a colliding project id keeps
 * the previous site's issue type and status map", "changing the Jira site is
 * accepted as a no-op").
 *
 * `projectChanged` compared `project.id` alone. Atlassian mints project ids
 * per-site starting at 10000 on every site, so the equivalent project on
 * another tenant routinely compares EQUAL — the client then skipped its resets
 * and the server's backstop skipped them for the identical reason. The stored
 * config read as fully configured while pointing at ids that exist on a
 * different tenant.
 */
describe('Jira site switch — everything below the site is per-tenant', () => {
  const TWO_SITES = [
    { id: 'cafe0001', name: 'Acme', url: 'https://acme.atlassian.net' },
    { id: 'cafe0002', name: 'Acme Sandbox', url: 'https://acme-sandbox.atlassian.net' },
  ]

  it('drops the saved project, issue type and status map from the VIEW', async () => {
    installFetch({ config: SAVED_DESTINATION, sites: TWO_SITES })
    await mount()
    // Before: the saved destination is on show.
    expect(container.textContent).toContain('Currently pushing to')
    expect(selects()[1].value).toBe('10001')
    expect(bucketSelects()).toHaveLength(4)

    await act(async () => selectOption(selects()[0], 'cafe0002'))
    await flush()
    await flush()

    // After: nothing below the site is claimed, because none of it is addressed
    // by an id that means anything on the new tenant.
    expect(container.textContent).not.toContain('Currently pushing to')
    expect(container.textContent).toContain('Pick the project pushed actions land in.')
    // The issue-type and status-map sections are gone entirely (they render only
    // for a project), so the only select left is the site itself.
    expect(selects()).toHaveLength(1)
  })

  it('never asks the NEW site about the OLD site’s project', async () => {
    installFetch({ config: SAVED_DESTINATION, sites: TWO_SITES })
    await mount()

    await act(async () => selectOption(selects()[0], 'cafe0002'))
    await flush()
    await flush()

    const crossed = pickerUrls.filter(
      (u) => u.includes('cloudId=cafe0002') && u.includes('projectId='),
    )
    expect(crossed).toEqual([])
    // It does browse the new site's projects, which is the whole point.
    expect(pickerUrls.some((u) => u.includes('/projects?cloudId=cafe0002'))).toBe(true)
  })

  it('resets the map and the issue type even when the new project id COLLIDES', async () => {
    installFetch({
      config: {
        ...SAVED_DESTINATION,
        status_map: { not_started: '30001', in_progress: null, done: '30003', canceled: null },
      },
      sites: TWO_SITES,
    })
    await mount()

    await act(async () => selectOption(selects()[0], 'cafe0002'))
    await waitFor(() => hasButton('ENGEngineering'), 'the new site’s project list')
    // Site B's project happens to carry the SAME numeric id as site A's.
    await act(async () => button('ENGEngineering').click())
    await waitForPatches(1)

    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      cloud_id: 'cafe0002',
      site_name: 'Acme Sandbox',
      project_id: '10000',
      status_map: { not_started: null, in_progress: null, done: null, canceled: null },
    })
  })

  /**
   * REGRESSION (review finding: "site_url falls back to the API gateway,
   * storing an unusable /browse permalink on every link"). The picker used to
   * substitute `https://api.atlassian.com/ex/jira/{cloudId}` — the OAuth
   * gateway — purely to satisfy a non-empty-string requirement, and every push
   * then wrote `{gateway}/browse/ENG-42` onto its link row, where it stays.
   */
  it('sends site_url: null for a site Atlassian reports no url for', async () => {
    installFetch({
      config: SITE,
      sites: [
        { id: 'cafe0001', name: 'Acme', url: 'https://acme.atlassian.net' },
        { id: 'cafe0002', name: 'Acme Sandbox', url: null },
      ],
    })
    await mount()

    await act(async () => selectOption(selects()[0], 'cafe0002'))
    await waitFor(() => hasButton('ENGEngineering'), 'the new site’s project list')
    await act(async () => button('ENGEngineering').click())
    await waitForPatches(1)

    expect(patches[0]).toMatchObject({ cloud_id: 'cafe0002', site_url: null })
    expect(JSON.stringify(patches[0])).not.toContain('api.atlassian.com')
  })
})

// ---- 3. issue type ----------------------------------------------------------

describe('Jira issue type', () => {
  it('PATCHes the id with its display name', async () => {
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    await act(async () => selectOption(selects()[1], '10005'))
    await flush()

    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual({ issue_type_id: '10005', issue_type_name: 'Bug' })
  })

  it('is not offered before a project is picked', async () => {
    // There is no site-wide issue type: in a team-managed project the ids are
    // project-local copies, so the list cannot even be fetched yet.
    installFetch({ config: SITE })
    await mount()
    expect(container.textContent).not.toContain('Issue type')
  })
})

// ---- 4. clearing ------------------------------------------------------------

describe('Jira destination clear', () => {
  it('PATCHes {project_id: null} — the route’s explicit clear shape', async () => {
    // The picker can only ever SET a project, and every other PATCH merges, so
    // without this a workspace that picked one is stuck pushing to it forever.
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    await act(async () => button('Clear destination').click())
    await flush()

    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual({ project_id: null })
  })

  it('is hidden until a project is actually configured', async () => {
    installFetch({ config: SITE })
    await mount()
    expect(hasButton('Clear destination')).toBe(false)
  })

  it('optimistically drops the project and the issue type, KEEPING the site', async () => {
    // The site is the API address, not the destination — re-picking a tenant the
    // user is obviously still connected to is pure friction, and a site-only
    // config reads as unconfigured everywhere anyway.
    installFetch({ config: SAVED_DESTINATION })
    await mount()
    expect(container.textContent).toContain('Currently pushing to')

    await act(async () => button('Clear destination').click())
    await flush()

    expect(container.textContent).not.toContain('Currently pushing to')
    expect(hasButton('Clear destination')).toBe(false)
    // The site picker is still there, still selected.
    expect(selects()[0].value).toBe('cafe0001')
  })

  it('REVERTS the optimistic clear when the PATCH fails', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      failPatch: { status: 500, body: { error: 'Failed to save Jira settings' } },
    })
    await mount()

    await act(async () => button('Clear destination').click())
    await flush()

    expect(container.textContent).toContain('Failed to save Jira settings')
    expect(container.textContent).toContain('Currently pushing to')
  })
})

// ---- 5. picker failures -----------------------------------------------------

describe('Jira picker failures', () => {
  it('shows the reconnect banner INSTEAD of the pickers on reconnect_required', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      fail: {
        path: '/api/account/jira/sites',
        status: 400,
        body: { error: 'Reconnect Jira to continue', code: 'reconnect_required' },
      },
    })
    await mount()

    const text = container.textContent || ''
    expect(text).toContain('Reconnect Jira to manage the destination')
    expect(hasButton('Reconnect Jira')).toBe(true)
    // The dropdowns are hidden — an empty picker reads as "you have no projects".
    expect(text).not.toContain('Atlassian site')
    expect(container.querySelectorAll('select')).toHaveLength(0)
  })

  it('treats not_connected the same way (same fix: reconnect)', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      fail: {
        path: '/api/account/jira/sites',
        status: 400,
        body: { error: 'Jira is not connected for this workspace', code: 'not_connected' },
      },
    })
    await mount()

    expect(container.textContent).toContain('Reconnect Jira to manage the destination')
  })

  it('shows an inline error with a Retry for a generic failure, keeping the pickers', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      fail: {
        path: '/api/account/jira/projects',
        status: 500,
        body: { error: 'Failed to list Jira projects' },
      },
    })
    await mount()

    const text = container.textContent || ''
    expect(text).toContain('Failed to list Jira projects')
    expect(text).not.toContain('Reconnect Jira to manage the destination')
    expect(hasButton('Retry')).toBe(true)
    // The site picker still renders — only the projects call failed.
    expect(text).toContain('Atlassian site')
  })

  it('recovers on Retry once the route is healthy again', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      fail: {
        path: '/api/account/jira/projects',
        status: 500,
        body: { error: 'Failed to list Jira projects' },
      },
    })
    await mount()
    expect(container.textContent).toContain('Failed to list Jira projects')

    installFetch({ config: SAVED_DESTINATION })
    await act(async () => button('Retry').click())
    await flush()
    await flush()

    expect(container.textContent).not.toContain('Failed to list Jira projects')
    expect(container.textContent).toContain('Growth')
  })
})

// ---- attribution opt-out ---------------------------------------------------

/**
 * The "Pushed from Dial8" toggle — the Asana twin. Provider-level, so unlike
 * every other control in this section it is NOT gated on a destination being
 * picked, and it survives the site switch that invalidates everything else.
 */
describe('Jira attribution toggle', () => {
  function attributionSwitch(): HTMLElement {
    const el = container.querySelector(
      '[aria-label="Include a “Pushed from Dial8” link on pushed tasks"]',
    )
    expect(el, 'attribution switch').toBeTruthy()
    return el as HTMLElement
  }

  it('renders for a connected account with NO destination picked', async () => {
    installFetch({ config: {} })
    await mount()

    expect(container.textContent).toContain(
      'Include a “Pushed from Dial8” link on pushed tasks',
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
      failPatch: { status: 500, body: { error: 'Failed to save Jira settings' } },
    })
    await mount()
    expect(attributionSwitch().getAttribute('data-state')).toBe('checked')

    await act(async () => attributionSwitch().click())
    await flush()

    expect(container.textContent).toContain('Failed to save Jira settings')
    expect(attributionSwitch().getAttribute('data-state')).toBe('checked')
  })
})

// ---- 6. telling the push menu the destination moved -----------------------

/**
 * Jira's half of the freshness fix. The menu's cached destinations are only as
 * fresh as the announcements it hears, and Jira arrived after the Asana call
 * site existed — so the risk this pins is a settings page that saves correctly
 * and stays silent, leaving the menu insisting Jira is unconfigured.
 *
 * Asserted at the WINDOW EVENT rather than by spying on the module, so it holds
 * whatever `notifyTaskDestinationsChanged` is refactored into, and covers the
 * funnel every Jira write shares (`saveJiraDestination`) rather than one button.
 */
describe('Jira settings announce destination changes to the push menu', () => {
  let announcements: number

  beforeEach(() => {
    announcements = 0
    const onChanged = () => {
      announcements += 1
    }
    window.addEventListener(TASK_DESTINATIONS_CHANGED, onChanged)
    return () => window.removeEventListener(TASK_DESTINATIONS_CHANGED, onChanged)
  })

  it('announces when a status mapping is saved', async () => {
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    await act(async () => selectOption(bucketSelects()[2], 's-done'))
    await flush()

    expect(patches).toHaveLength(1)
    expect(announcements).toBeGreaterThan(0)
  })

  it('announces when the destination is cleared', async () => {
    installFetch({ config: SAVED_DESTINATION })
    await mount()

    await act(async () => button('Clear destination').click())
    await flush()

    expect(patches[0]).toEqual({ project_id: null })
    expect(announcements).toBeGreaterThan(0)
  })

  it('stays SILENT when the PATCH fails — nothing moved, so nothing is stale', async () => {
    installFetch({
      config: SAVED_DESTINATION,
      failPatch: { status: 500, body: { error: 'Failed to save Jira settings' } },
    })
    await mount()

    await act(async () => selectOption(bucketSelects()[2], 's-done'))
    await flush()

    expect(patches).toHaveLength(1)
    expect(announcements).toBe(0)
  })
})
