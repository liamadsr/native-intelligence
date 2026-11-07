// @vitest-environment jsdom
/**
 * THE PROPERTY LENS — an action's properties seen through the provider it was
 * pushed to.
 *
 * What this file pins is not "the chips render". It is the four claims that make
 * a lens different from the compose form it borrows its controls from:
 *
 *  - IT SHOWS THE TICKET, not a form's defaults. Every value on screen came from
 *    a live read of the linked ticket, so the tests assert the CHIP TEXT against
 *    the fetch fake's response body rather than against any local state.
 *  - IT WRITES PER FIELD, OPTIMISTICALLY, AND ROLLS BACK. A chip moves before the
 *    provider answers (that is the whole point — a chip that waited would feel
 *    broken) which means a rejected write must put the OLD value back. The
 *    rollback test is the one that would catch the worst possible bug here: a UI
 *    that claims an edit the provider refused.
 *  - EDITABLE AND READ-ONLY ARE DIFFERENT THINGS ON SCREEN. `editable` comes from
 *    the provider (Jira's editmeta can say no per issue), and a field it refuses
 *    must be DRAWN — muted, "Change in Jira" — rather than hidden. Hiding it
 *    would answer "which project is this in?" with silence.
 *  - THE SWITCHER IS ABSENT ON UNPUSHED ACTIONS. Zero change for the actions that
 *    were never pushed anywhere is a hard requirement, not a nicety, so it is
 *    tested from both surfaces.
 *
 * Radix's Select can't be driven in jsdom (pointer-capture and ResizeObserver
 * APIs it doesn't implement), so it is replaced with plain elements preserving
 * the contracts the components rely on — the SAME substitution
 * push-compose-panel.test.tsx makes, copied deliberately rather than imported:
 * the two suites pin the same primitives through different components, and a
 * shared mock would make a change to one suite's stub a silent change to the
 * other's subject.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
vi.mock('@/lib/cached-fetch', () => ({
  cachedJson: async (url: string) => {
    const res = await fetch(url)
    return res.ok ? res.json() : null
  },
}))

vi.mock('@/components/ui/select', async () => {
  const { createElement: e } = await import('react')
  return {
    Select: ({
      value,
      onValueChange,
      disabled,
      children,
    }: {
      value?: string
      onValueChange?: (v: string) => void
      disabled?: boolean
      children?: ReactNode
    }) =>
      e(
        'select',
        {
          value: value ?? '',
          disabled,
          onChange: (ev: { target: { value: string } }) => onValueChange?.(ev.target.value),
        },
        children,
      ),
    SelectTrigger: ({
      'aria-label': ariaLabel,
      className,
      children,
    }: {
      'aria-label'?: string
      className?: string
      children?: ReactNode
    }) => e('span', { 'data-select-label': ariaLabel, className }, children),
    SelectValue: () => null,
    SelectContent: ({ children }: { children?: ReactNode }) => e('optgroup', {}, children),
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) =>
      e('option', { value }, children),
  }
})

import { TaskLens, PropertyLensSwitcher, defaultLens, orderLensProviders } from '../task-lens'
import type { LensDetails } from '@/lib/tasks/task-lens'

// ---- fetch fake ------------------------------------------------------------

interface FetchConfig {
  /** The task-details GET body. A `code` makes it a failure. */
  details?: Partial<LensDetails> | { ok: false; code: string; error: string }
  /** HTTP status for the details read (failures need a non-2xx). */
  detailsStatus?: number
  /**
   * The PATCH response body, per call in order.
   *
   * `unknown` rather than a shaped type on purpose: half these fixtures are
   * SUCCESS bodies (a full `LensDetails`) and half are refusals
   * (`{ok:false, code, error}`), and the point of several tests is that the
   * component reads the discriminant itself rather than trusting a shape.
   */
  patch?: Array<{ status?: number; body: unknown }>
  /**
   * Hold every PATCH open instead of answering it.
   *
   * The interleave tests below are ABOUT the window where two writes are in
   * flight at once, and a fake that answers synchronously has no such window —
   * the first `await` in `saveField` resolves before the second gesture is even
   * dispatched. With this on, each PATCH parks in `deferred` and the test
   * releases them BY FIELD, in whatever order the bug needs.
   */
  deferPatch?: boolean
  /** Which providers report a link row, for useActionLinkProviders. */
  linkedProviders?: string[]
  jiraUsers?: Array<{ account_id: string; display_name: string }>
  jiraPriorities?: Array<{ id: string; name: string }>
  asanaUsers?: Array<{ gid: string; name: string }>
  asanaTags?: Array<{ gid: string; name: string }>
  linearMembers?: Array<{ id: string; name: string; full_name: string | null }>
  linearLabels?: Array<{ id: string; name: string }>
}

let calls: Array<{ url: string; method: string; body: unknown }> = []

/**
 * PATCHes parked by `deferPatch`, in call order, each with the resolver that
 * answers it. Keyed by the FIELD the write names, because that is how the tests
 * talk about them ("release the assignee save, refused").
 */
interface DeferredPatch {
  field: string
  body: unknown
  resolve: (answer: { status?: number; body: unknown }) => void
}
let deferred: DeferredPatch[] = []

/** Answer a parked PATCH by the field it wrote, and let React flush. */
async function releasePatch(field: string, answer: { status?: number; body: unknown }) {
  const index = deferred.findIndex((d) => d.field === field)
  if (index === -1) throw new Error(`no deferred PATCH for field ${field}`)
  const [entry] = deferred.splice(index, 1)
  await act(async () => {
    entry.resolve(answer)
    // Two microtask turns: one for the fetch promise, one for `res.json()`.
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Which field a PATCH body names — `{fields: {assignee_id: ...}}` → 'assignee'. */
function patchedField(body: unknown): string {
  const fields = (body as { fields?: Record<string, unknown> } | undefined)?.fields ?? {}
  const key = Object.keys(fields)[0] ?? ''
  if (key === 'assignee_id') return 'assignee'
  if (key === 'priority_id') return 'priority'
  if (key === 'due_date') return 'due_date'
  if (key === 'label_ids') return 'labels'
  return key
}

/** A full Jira lens read with everything editable — the happy path. */
function jiraDetails(overrides: Partial<LensDetails> = {}): LensDetails {
  return {
    ok: true,
    provider: 'jira',
    link_id: 'link-1',
    url: 'https://acme.atlassian.net/browse/KAN-3',
    title: 'Ship the thing',
    status_name: 'In Progress',
    fields: {
      project: { id: '10001', name: 'Kanban' },
      issue_type: { id: '10002', name: 'Task' },
      team: null,
      section: null,
      assignee: { id: 'acc-1', name: 'Ada Lovelace' },
      priority: { id: '3', name: 'Medium' },
      due_date: '2026-03-14',
      labels: [{ id: 'backend', name: 'backend' }],
      ...(overrides.fields ?? {}),
    },
    editable: { assignee: true, priority: true, due_date: true, labels: true, ...(overrides.editable ?? {}) },
    option_scope: {
      cloud_id: 'cloud-1',
      site_url: 'https://acme.atlassian.net',
      project_id: '10001',
      project_key: 'KAN',
      issue_type_id: '10002',
      ...(overrides.option_scope ?? {}),
    },
    ...overrides,
  } as LensDetails
}

function asanaDetails(overrides: Partial<LensDetails> = {}): LensDetails {
  return {
    ok: true,
    provider: 'asana',
    link_id: 'link-a',
    url: 'https://app.asana.com/0/1/2',
    title: 'Ship the thing',
    status_name: 'In progress',
    fields: {
      project: { id: 'p1', name: 'Launch' },
      issue_type: null,
      team: null,
      section: { id: 's1', name: 'Doing' },
      assignee: { id: 'u1', name: 'Grace Hopper' },
      priority: null,
      due_date: '2026-04-01',
      labels: [],
      ...(overrides.fields ?? {}),
    },
    editable: { assignee: true, priority: false, due_date: true, labels: true, ...(overrides.editable ?? {}) },
    option_scope: { workspace_gid: 'ws-gid-1', project_id: 'p1', ...(overrides.option_scope ?? {}) },
    ...overrides,
  } as LensDetails
}

function linearDetails(overrides: Partial<LensDetails> = {}): LensDetails {
  return {
    ok: true,
    provider: 'linear',
    link_id: 'link-l',
    url: 'https://linear.app/acme/issue/ENG-42',
    title: 'Ship the thing',
    status_name: 'Todo',
    fields: {
      project: { id: 'lp1', name: 'Platform' },
      issue_type: null,
      team: { id: 't1', name: 'Engineering' },
      section: null,
      assignee: { id: 'lm1', name: 'Alan Turing' },
      priority: { id: '2', name: 'High' },
      due_date: null,
      labels: [{ id: 'lab-1', name: 'bug' }],
      ...(overrides.fields ?? {}),
    },
    editable: { assignee: true, priority: true, due_date: true, labels: true, ...(overrides.editable ?? {}) },
    option_scope: { team_id: 't1', ...(overrides.option_scope ?? {}) },
    ...overrides,
  } as LensDetails
}

function installFetch(cfg: FetchConfig = {}) {
  calls = []
  deferred = []
  const patchQueue = [...(cfg.patch ?? [])]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(init.body) : undefined,
      })
      const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body })

      if (method === 'PATCH') {
        const parsed = init?.body ? JSON.parse(init.body) : undefined
        if (cfg.deferPatch) {
          return new Promise((resolve) => {
            deferred.push({
              field: patchedField(parsed),
              body: parsed,
              resolve: (answer) => resolve(ok(answer.body, answer.status ?? 200)),
            })
          })
        }
        const next = patchQueue.shift()
        if (!next) return ok({ ok: false, code: 'provider_error', error: 'no patch queued' }, 502)
        return ok(next.body, next.status ?? 200)
      }

      if (url.includes('/task-details')) {
        const status = cfg.detailsStatus ?? 200
        return ok(cfg.details ?? jiraDetails(), status)
      }

      // The link routes useActionLinkProviders walks — one per provider.
      const linkMatch = /\/api\/account\/actions\/[^/]+\/(asana|jira|linear)$/.exec(url)
      if (linkMatch) {
        const provider = linkMatch[1]
        const linked = cfg.linkedProviders ?? []
        return ok({ tasks: linked.includes(provider) ? [{ id: `link-${provider}`, provider }] : [] })
      }

      if (url.includes('/jira/assignable-users')) return ok({ users: cfg.jiraUsers ?? [] })
      if (url.includes('/jira/compose-meta'))
        return ok({ meta: { priorities: cfg.jiraPriorities ?? [] }, native_create_url: null, cached: false })
      if (url.includes('/asana/users')) return ok({ users: cfg.asanaUsers ?? [] })
      if (url.includes('/asana/tags')) return ok({ tags: cfg.asanaTags ?? [] })
      if (url.includes('/linear/members')) return ok({ members: cfg.linearMembers ?? [] })
      if (url.includes('/linear/labels')) return ok({ labels: cfg.linearLabels ?? [] })
      return ok({})
    }),
  )
}

// ---- harness ---------------------------------------------------------------

let container: HTMLDivElement
let root: Root

async function renderLens(props: Partial<Parameters<typeof TaskLens>[0]> = {}) {
  await act(async () => {
    root.render(
      h(TaskLens, {
        actionId: 'act-1',
        provider: 'jira',
        layout: 'strip',
        ...props,
      }),
    )
  })
}

/** A chip by its `data-lens-field` marker, whatever element it turned out to be. */
function chip(field: string): HTMLElement | undefined {
  return (container.querySelector(`[data-lens-field="${field}"]`) as HTMLElement | null) ?? undefined
}

function selectByLabel(label: string): HTMLSelectElement | undefined {
  const marker = Array.from(container.querySelectorAll('[data-select-label]')).find(
    (el) => el.getAttribute('data-select-label') === label,
  )
  return marker?.closest('select') as HTMLSelectElement | undefined
}

async function setSelect(label: string, value: string) {
  const select = selectByLabel(label)!
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function patchCalls() {
  return calls.filter((c) => c.method === 'PATCH')
}

beforeEach(() => {
  vi.clearAllMocks()
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// ---------------------------------------------------------------------------

describe('defaultLens / orderLensProviders — the default-lens rule', () => {
  it('no links → dial8', () => {
    expect(defaultLens([])).toBe('dial8')
  })

  it('one link → that provider', () => {
    expect(defaultLens(['linear'])).toBe('linear')
  })

  /**
   * THE RANKING IS THE ICON STACK'S. An action whose platform mark stack draws
   * Asana first must not open its lens on Jira — the two would disagree about
   * "which tracker is this action's", on the same screen.
   */
  it('several links → the first by canonical rank, regardless of arrival order', () => {
    expect(defaultLens(['linear', 'jira', 'asana'])).toBe('asana')
    expect(defaultLens(['linear', 'jira'])).toBe('jira')
    expect(orderLensProviders(['linear', 'asana', 'jira'])).toEqual(['asana', 'jira', 'linear'])
  })

  it('de-duplicates, because an optimistic patch can add a link twice', () => {
    expect(orderLensProviders(['jira', 'jira', 'asana'])).toEqual(['asana', 'jira'])
  })
})

describe('PropertyLensSwitcher', () => {
  it('renders one tab per provider, Dial8 included, and marks the active one', async () => {
    await act(async () => {
      root.render(
        h(PropertyLensSwitcher, {
          providers: ['dial8', 'jira', 'linear'],
          active: 'jira',
          onChange: vi.fn(),
        }),
      )
    })
    const tabs = Array.from(container.querySelectorAll('[data-lens-tab]'))
    expect(tabs.map((t) => t.getAttribute('data-lens-tab'))).toEqual(['dial8', 'jira', 'linear'])
    const jira = container.querySelector('[data-lens-tab="jira"]')!
    expect(jira.getAttribute('aria-pressed')).toBe('true')
    expect(jira.className).toContain('bg-secondary')
    expect(container.querySelector('[data-lens-tab="dial8"]')!.getAttribute('aria-pressed')).toBe('false')
  })

  /** A brand mark is no help to a screen reader; the sentence is the name. */
  it('names each tab as a sentence rather than a glyph', async () => {
    await act(async () => {
      root.render(
        h(PropertyLensSwitcher, { providers: ['dial8', 'asana'], active: 'dial8', onChange: vi.fn() }),
      )
    })
    expect(container.querySelector('[data-lens-tab="asana"]')!.getAttribute('aria-label')).toBe(
      'View Asana properties',
    )
    expect(container.querySelector('[data-lens-tab="dial8"]')!.getAttribute('aria-label')).toBe(
      'View Dial8 properties',
    )
  })

  it('reports the picked provider without letting the click reach the surface underneath', async () => {
    const onChange = vi.fn()
    const rowClick = vi.fn()
    await act(async () => {
      root.render(
        h(
          'div',
          { onClick: rowClick },
          h(PropertyLensSwitcher, { providers: ['dial8', 'jira'], active: 'dial8', onChange }),
        ),
      )
    })
    await act(async () => {
      container
        .querySelector('[data-lens-tab="jira"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('jira')
    // The capture row's own click opens things; a lens flip must not.
    expect(rowClick).not.toHaveBeenCalled()
  })
})

describe('TaskLens — live values per provider', () => {
  it('reads the linked ticket on mount, from the task-details route for THIS provider', async () => {
    installFetch({ details: jiraDetails() })
    await renderLens({ provider: 'jira' })
    const read = calls.find((c) => c.url.includes('/task-details'))!
    expect(read.url).toContain('/api/account/actions/act-1/task-details')
    expect(read.url).toContain('provider=jira')
    expect(read.method).toBe('GET')
  })

  /**
   * THE VALUES ON SCREEN ARE THE TICKET'S. Asserted against the response body,
   * which is the only claim that distinguishes a lens from a blank form.
   */
  it('Jira: draws project, issue type, status, assignee, priority, due date and labels', async () => {
    installFetch({
      details: jiraDetails(),
      jiraUsers: [{ account_id: 'acc-1', display_name: 'Ada Lovelace' }],
      jiraPriorities: [
        { id: '1', name: 'Highest' },
        { id: '3', name: 'Medium' },
      ],
    })
    await renderLens({ provider: 'jira' })

    expect(chip('project')!.textContent).toContain('Kanban')
    expect(chip('issue_type')!.textContent).toContain('Task')
    expect(chip('status')!.textContent).toContain('In Progress')
    // Editable chips are Selects — their VALUE is the ticket's current id.
    expect(selectByLabel('Jira assignee')!.value).toBe('acc-1')
    expect(selectByLabel('Jira priority')!.value).toBe('3')
    expect(chip('labels')!.textContent).toContain('backend')
  })

  it('Asana: draws section, and NO priority chip at all (the provider has no such field)', async () => {
    installFetch({ details: asanaDetails() })
    await renderLens({ provider: 'asana' })

    expect(chip('section')!.textContent).toContain('Doing')
    expect(chip('assignee')).toBeTruthy()
    // Not even a read-only one: drawing it would assert a property Asana lacks.
    expect(chip('priority')).toBeUndefined()
  })

  it('Linear: draws team, and its priority comes from the fixed 0-4 scale', async () => {
    installFetch({ details: linearDetails() })
    await renderLens({ provider: 'linear' })

    expect(chip('team')!.textContent).toContain('Engineering')
    const priority = selectByLabel('Linear priority')!
    expect(priority.value).toBe('2')
    // The scale is workspace-wide and fixed, so no route is asked for it.
    expect(calls.some((c) => c.url.includes('priorit'))).toBe(false)
    expect(Array.from(priority.querySelectorAll('option')).map((o) => o.textContent)).toContain('Urgent')
  })

  it('links out to the ticket', async () => {
    installFetch({ details: jiraDetails() })
    await renderLens({ provider: 'jira' })
    const link = container.querySelector('[data-lens-open]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://acme.atlassian.net/browse/KAN-3')
    expect(link.getAttribute('aria-label')).toBe('Open in Jira')
  })
})

describe('TaskLens — editable versus read-only', () => {
  /**
   * A field the provider refuses is DRAWN, not hidden. Jira's editmeta says no
   * per issue (workflow state, screen scheme, permissions) and the answer to
   * "who is this assigned to" is still the assignee's name.
   */
  it('a non-editable field renders as a muted pill with `Change in {Provider}`', async () => {
    installFetch({
      details: jiraDetails({ editable: { assignee: false, priority: true, due_date: true, labels: true } }),
    })
    await renderLens({ provider: 'jira' })

    const assignee = chip('assignee')!
    expect(assignee.getAttribute('data-lens-readonly')).toBe('')
    expect(assignee.textContent).toContain('Ada Lovelace')
    expect(assignee.getAttribute('title')).toBe('Change in Jira')
    // And it is NOT a select — there is nothing to pick.
    expect(selectByLabel('Jira assignee')).toBeUndefined()
  })

  it('project / issue type / team / section / status are read-only on every provider', async () => {
    installFetch({ details: jiraDetails() })
    await renderLens({ provider: 'jira' })
    for (const field of ['project', 'issue_type', 'status']) {
      expect(chip(field)!.getAttribute('data-lens-readonly')).toBe('')
    }

    installFetch({ details: linearDetails() })
    await renderLens({ provider: 'linear' })
    for (const field of ['team', 'project', 'status']) {
      expect(chip(field)!.getAttribute('data-lens-readonly')).toBe('')
    }
  })

  /**
   * STATUS IS NEVER WRITTEN. It already has an owner — the Dial8→provider echo —
   * and a second writer would race the CAS loop-breaker the read-back depends on.
   */
  it('never offers status as an editable control', async () => {
    installFetch({ details: jiraDetails() })
    await renderLens({ provider: 'jira' })
    expect(selectByLabel('Jira status')).toBeUndefined()
    expect(chip('status')!.getAttribute('data-lens-readonly')).toBe('')
  })

  /**
   * THE READ-ONLY LABELS PATH, which nothing else here exercises.
   *
   * `editable.labels` false is a branch with its own early return inside the
   * labels control, and it is a live shape (a Jira issue whose editmeta omits
   * labels). Worth its own case for a second reason: the flag ARRIVES WITH THE
   * DETAILS FETCH, so this branch is the one every lens renders for one frame
   * before the response lands — which is what made an early return there a
   * hooks-order hazard (`react-hooks/rules-of-hooks` is the actual guard; this
   * test is the behavioural half).
   */
  it('draws labels read-only, with no toggles, when the provider refuses the field', async () => {
    installFetch({
      details: asanaDetails({
        editable: { assignee: true, priority: false, due_date: true, labels: false },
        fields: { ...asanaDetails().fields, labels: [{ id: 't1', name: 'design' }] },
      }),
    })
    await renderLens({ provider: 'asana' })

    const labels = chip('labels')!
    expect(labels.getAttribute('data-lens-readonly')).toBe('')
    expect(labels.textContent).toContain('design')
    // No toggles offered, because nothing here is writable.
    expect(container.querySelector('[data-lens-labels-trigger]')).toBeNull()
  })

  it('unions the ticket\'s current assignee into the options, so a Select is never blank', async () => {
    // The roster route omits the current assignee (a departed teammate, a
    // cross-team assignment) — a Select whose value is absent renders empty.
    installFetch({
      details: jiraDetails(),
      jiraUsers: [{ account_id: 'acc-2', display_name: 'Someone Else' }],
    })
    await renderLens({ provider: 'jira' })
    const options = Array.from(selectByLabel('Jira assignee')!.querySelectorAll('option'))
    expect(options.map((o) => o.textContent)).toContain('Ada Lovelace')
    expect(selectByLabel('Jira assignee')!.value).toBe('acc-1')
  })
})

describe('TaskLens — optimistic save', () => {
  it('PATCHes the one field that changed, to the link route', async () => {
    installFetch({
      details: jiraDetails(),
      jiraUsers: [
        { account_id: 'acc-1', display_name: 'Ada Lovelace' },
        { account_id: 'acc-2', display_name: 'Grace Hopper' },
      ],
      patch: [{ body: jiraDetails({ fields: { ...jiraDetails().fields, assignee: { id: 'acc-2', name: 'Grace Hopper' } } }) }],
    })
    await renderLens({ provider: 'jira' })
    await setSelect('Jira assignee', 'acc-2')

    const patch = patchCalls()[0]
    expect(patch.url).toBe('/api/account/actions/act-1/jira/link-1')
    // ONLY the changed field travels — an absent key means "do not touch".
    expect(patch.body).toEqual({ fields: { assignee_id: 'acc-2' } })
  })

  /**
   * RECONCILED FROM THE RESPONSE, not from the optimistic guess. The provider is
   * the authority on what it stored — Jira normalises label case, Linear returns
   * a display name for an id we sent — and a lens that kept its own guess would
   * show a value the ticket does not have.
   */
  it('reconciles the chip from the PATCH response body', async () => {
    const after = jiraDetails({
      fields: { ...jiraDetails().fields, assignee: { id: 'acc-2', name: 'Grace Hopper' } },
    })
    installFetch({
      details: jiraDetails(),
      jiraUsers: [
        { account_id: 'acc-1', display_name: 'Ada Lovelace' },
        { account_id: 'acc-2', display_name: 'Grace Hopper' },
      ],
      patch: [{ body: after }],
    })
    await renderLens({ provider: 'jira' })
    await setSelect('Jira assignee', 'acc-2')
    expect(selectByLabel('Jira assignee')!.value).toBe('acc-2')
  })

  it('clearing a field sends an explicit null rather than omitting it', async () => {
    installFetch({
      details: jiraDetails(),
      jiraUsers: [{ account_id: 'acc-1', display_name: 'Ada Lovelace' }],
      patch: [{ body: jiraDetails({ fields: { ...jiraDetails().fields, assignee: null } }) }],
    })
    await renderLens({ provider: 'jira' })
    // The none-row's sentinel is translated back to null by OptionSelect.
    await setSelect('Jira assignee', '__none__')
    // ABSENT would mean "leave the old assignee"; null is the clear.
    expect(patchCalls()[0].body).toEqual({ fields: { assignee_id: null } })
  })

  it('a label toggle sends the FULL replacement set', async () => {
    installFetch({
      details: linearDetails(),
      linearLabels: [
        { id: 'lab-1', name: 'bug' },
        { id: 'lab-2', name: 'urgent' },
      ],
      patch: [{ body: linearDetails() }],
    })
    await renderLens({ provider: 'linear' })
    // Open the strip's summary chip, then toggle the unselected label on.
    await act(async () => {
      container
        .querySelector('[data-lens-labels-trigger]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const urgent = Array.from(container.querySelectorAll('[data-lens-labels] button')).find(
      (b) => b.getAttribute('aria-label') === 'urgent',
    )!
    await act(async () => {
      urgent.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Not a delta — the complete set, which is what the wire takes.
    expect(patchCalls()[0].body).toEqual({ fields: { label_ids: ['lab-1', 'lab-2'] } })
  })
})

describe('TaskLens — rollback', () => {
  /**
   * THE WORST BUG THIS FEATURE COULD HAVE is a chip that claims an edit the
   * provider refused. The chip moves first (that is what makes it feel like a
   * property rather than a form) so a rejection must put the old value back.
   */
  it('rolls the chip back to its old value and toasts when the write is refused', async () => {
    installFetch({
      details: jiraDetails(),
      jiraUsers: [
        { account_id: 'acc-1', display_name: 'Ada Lovelace' },
        { account_id: 'acc-2', display_name: 'Grace Hopper' },
      ],
      patch: [
        {
          status: 200,
          body: { ok: false, code: 'field_not_editable', error: 'Assignee is not on the edit screen' },
        },
      ],
    })
    await renderLens({ provider: 'jira' })
    expect(selectByLabel('Jira assignee')!.value).toBe('acc-1')

    await setSelect('Jira assignee', 'acc-2')

    // Back to the ticket's real value...
    expect(selectByLabel('Jira assignee')!.value).toBe('acc-1')
    // ...and the reason is surfaced, as a toast rather than a banner: the other
    // fields are still fine and still editable.
    expect(toastMock.error).toHaveBeenCalledWith('Assignee is not on the edit screen')
    // The lens is still a lens — not replaced by an error state.
    expect(container.querySelector('[data-lens-failure]')).toBeNull()
  })

  it('rolls back on a network failure too', async () => {
    installFetch({
      details: jiraDetails(),
      jiraUsers: [
        { account_id: 'acc-1', display_name: 'Ada Lovelace' },
        { account_id: 'acc-2', display_name: 'Grace Hopper' },
      ],
      patch: [{ status: 502, body: { ok: false, code: 'provider_error', error: 'Jira is unavailable' } }],
    })
    await renderLens({ provider: 'jira' })
    await setSelect('Jira assignee', 'acc-2')
    expect(selectByLabel('Jira assignee')!.value).toBe('acc-1')
    expect(toastMock.error).toHaveBeenCalledWith('Jira is unavailable')
  })
})

/**
 * TWO WRITES AT ONCE — the case a single shared generation counter gets wrong.
 *
 * The lens saves per field and the fields are independent, so two chips can be in
 * flight at the same time; a WAN hop to Jira is ~400ms and a user editing an
 * assignee and then a due date will land inside that window every time. The shape
 * these tests were written against had ONE `generation` ref bumped by the details
 * fetch AND by every save, with every response checking it, which loses two races
 * at once:
 *
 *  - Save A's REFUSAL is swallowed. B's bump makes A's `generation.current !==
 *    started` true, so A returns early — past its rollback and past its toast. The
 *    UI keeps a value the provider refused, silently. That is the single worst bug
 *    this feature can have, and it is the first test below.
 *  - Then B's rollback RE-COMMITS it. B captured a snapshot of the whole `details`
 *    object, taken after A's optimistic patch, so restoring it puts A's refused
 *    value back a second time — from a code path that looks like it is undoing
 *    something else entirely.
 *
 * These are driven with `deferPatch`, which parks each PATCH until the test
 * releases it by field. An auto-answering fake has no concurrency window at all:
 * the first `await` in `saveField` resolves before the second gesture is
 * dispatched, so both saves run strictly in series and every assertion here passes
 * against the broken code.
 *
 * `stack` layout throughout, because that is where `DateField` is a native
 * `<input type="date">` and can be driven at all in jsdom.
 */
describe('TaskLens — concurrent saves on different fields', () => {
  const twoField = () =>
    installFetch({
      details: jiraDetails(),
      deferPatch: true,
      jiraUsers: [
        { account_id: 'acc-1', display_name: 'Ada Lovelace' },
        { account_id: 'acc-2', display_name: 'Grace Hopper' },
      ],
    })

  /** The due-date input, which in `stack` is a plain native field. */
  function dueInput(): HTMLInputElement {
    return container.querySelector('input[type="date"]') as HTMLInputElement
  }

  /**
   * Type into the native date input, THROUGH React's value tracker.
   *
   * Assigning `input.value` directly is not enough for a CONTROLLED input: React
   * caches the last value it rendered on the DOM node and skips `onChange` when
   * the incoming value matches its cache, so a direct assignment produces a
   * changed DOM and no handler call at all. Going through the prototype's setter
   * updates the node without touching React's cache, and the subsequent `input`
   * event then reads as a real user edit. (The `<select>` fakes above do not need
   * this — the Radix stub is an uncontrolled `<select>` with a plain `onChange`.)
   */
  async function setDue(value: string) {
    const input = dueInput()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  /**
   * THE HEADLINE. A refused write must roll back and say so even though a second
   * write started while it was in flight. The old code returned early here and the
   * chip kept `acc-2` — a value Jira rejected — with no toast at all.
   */
  it('a refused save still rolls back and toasts when another field\'s save started first', async () => {
    twoField()
    await renderLens({ provider: 'jira', layout: 'stack' })

    // A: assignee → Grace. B: due date → April. Both in flight.
    await setSelect('Jira assignee', 'acc-2')
    await setDue('2026-04-02')
    expect(deferred.map((d) => d.field).sort()).toEqual(['assignee', 'due_date'])

    // A comes back REFUSED, with B still out there.
    await releasePatch('assignee', {
      status: 200,
      body: { ok: false, code: 'field_not_editable', error: 'Assignee is not on the edit screen' },
    })

    // Rolled back to the ticket's real assignee...
    expect(selectByLabel('Jira assignee')!.value).toBe('acc-1')
    // ...and the user was told why.
    expect(toastMock.error).toHaveBeenCalledWith('Assignee is not on the edit screen')
    // The lens is still a lens — one rejected chip is not a broken surface.
    expect(container.querySelector('[data-lens-failure]')).toBeNull()
  })

  /**
   * A's failure must not disturb B, whose write the provider never refused.
   *
   * The A-rolled-back assertion is not redundant with the headline test: without
   * it this case passes vacuously against the broken code, where A returns early
   * and so trivially disturbs nothing. Both halves together are what pin
   * "surgical" — A moved, B did not.
   */
  it('the concurrent field is untouched by the other\'s rollback', async () => {
    twoField()
    await renderLens({ provider: 'jira', layout: 'stack' })

    await setSelect('Jira assignee', 'acc-2')
    await setDue('2026-04-02')

    await releasePatch('assignee', {
      status: 200,
      body: { ok: false, code: 'provider_error', error: 'nope' },
    })

    // A rolled back...
    expect(selectByLabel('Jira assignee')!.value).toBe('acc-1')
    // ...and B's optimistic value survived it.
    expect(dueInput().value).toBe('2026-04-02')

    // And when B succeeds it reconciles from ITS response, still without
    // resurrecting A's refused assignee.
    await releasePatch('due_date', {
      body: jiraDetails({ fields: { ...jiraDetails().fields, due_date: '2026-04-02' } }),
    })
    expect(dueInput().value).toBe('2026-04-02')
    expect(selectByLabel('Jira assignee')!.value).toBe('acc-1')
  })

  /**
   * THE RE-COMMIT. Both writes fail; B's rollback must restore only B's field.
   * A whole-details snapshot restore puts A's refused assignee back on screen,
   * which is the second half of the original bug and the reason the rollback is
   * per-field rather than per-object.
   */
  it('a second failure rolls back only its own field, never re-committing the first\'s refused value', async () => {
    twoField()
    await renderLens({ provider: 'jira', layout: 'stack' })

    await setSelect('Jira assignee', 'acc-2')
    await setDue('2026-04-02')

    await releasePatch('assignee', {
      status: 200,
      body: { ok: false, code: 'field_not_editable', error: 'assignee refused' },
    })
    await releasePatch('due_date', {
      status: 502,
      body: { ok: false, code: 'provider_error', error: 'due date refused' },
    })

    // Both back to the ticket's real values. The assignee especially: B's
    // rollback must not resurrect `acc-2`.
    expect(selectByLabel('Jira assignee')!.value).toBe('acc-1')
    expect(dueInput().value).toBe('2026-03-14')
    expect(toastMock.error).toHaveBeenCalledWith('assignee refused')
    expect(toastMock.error).toHaveBeenCalledWith('due date refused')
  })

  /**
   * A SUCCESS while another field is still pending adopts only ITS field. The
   * PATCH response is a full ticket read taken BEFORE the other write reached the
   * provider, so adopting it wholesale would undo the other chip in front of the
   * user — the mirror image of the rollback bug.
   *
   * HONEST ABOUT ITS REACH: unlike the rollback cases above, this one does NOT go
   * red against the shape it was written for — the broken code dropped A's success
   * on the floor, and A's optimistic value happens to equal what a correct
   * reconcile produces, so both assertions hold for the wrong reason. It is kept
   * because the `othersPending` branch it covers is otherwise untested, and the
   * moment that branch adopts the response wholesale (the tempting simplification)
   * this test is the one that catches B being stomped.
   */
  it('a success reconciles only its own field while another save is pending', async () => {
    twoField()
    await renderLens({ provider: 'jira', layout: 'stack' })

    await setSelect('Jira assignee', 'acc-2')
    await setDue('2026-04-02')

    // The provider's read-back of the assignee write still shows the OLD due
    // date, because B had not landed when it was taken.
    await releasePatch('assignee', {
      body: jiraDetails({
        fields: {
          ...jiraDetails().fields,
          assignee: { id: 'acc-2', name: 'Grace Hopper' },
          due_date: '2026-03-14',
        },
      }),
    })

    expect(selectByLabel('Jira assignee')!.value).toBe('acc-2')
    // B's optimistic value is NOT stomped by A's stale read-back.
    expect(dueInput().value).toBe('2026-04-02')
  })

  /** Each chip disables itself and only itself — the point of per-field tracking. */
  it('a save in flight disables only its own chip', async () => {
    twoField()
    await renderLens({ provider: 'jira', layout: 'stack' })

    await setSelect('Jira assignee', 'acc-2')
    expect(selectByLabel('Jira assignee')!.disabled).toBe(true)
    // Priority is a different field and a different write — still live.
    expect(selectByLabel('Jira priority')!.disabled).toBe(false)
    // ...and the due-date chip is genuinely editable, so the second gesture is
    // even possible (a single `savingField` string would have overwritten
    // 'assignee' here and re-enabled the assignee select mid-flight).
    await setDue('2026-04-02')
    expect(selectByLabel('Jira assignee')!.disabled).toBe(true)
    expect(patchCalls().length).toBe(2)
  })

  /**
   * DUE DATE GETS THE SAME IN-FLIGHT DISCIPLINE, from outside the primitive:
   * `DateField` takes no `disabled` (it was extracted for a form where nothing is
   * in flight), so the lens gates the gesture itself. Two writes to the SAME field
   * would race and the loser's response would reconcile the UI backwards.
   */
  it('refuses a second write to the due-date field while its first is in flight', async () => {
    twoField()
    await renderLens({ provider: 'jira', layout: 'stack' })

    await setDue('2026-04-02')
    expect(patchCalls().length).toBe(1)
    expect(chip('due_date')!.getAttribute('data-lens-saving')).toBe('')

    await setDue('2026-04-03')
    // Still one — the field is busy.
    expect(patchCalls().length).toBe(1)

    await releasePatch('due_date', {
      body: jiraDetails({ fields: { ...jiraDetails().fields, due_date: '2026-04-02' } }),
    })
    // Free again once the write lands.
    expect(chip('due_date')!.getAttribute('data-lens-saving')).toBeNull()
    await setDue('2026-04-04')
    expect(patchCalls().length).toBe(2)
  })
})

describe('TaskLens — same-field supersede and lens invalidation', () => {
  /**
   * SUCCESSIVE WRITES TO THE SAME FIELD each roll back to the value that field
   * held when THAT write started — never to an older snapshot.
   *
   * Labels are the field this is reachable on (`LabelsControl` disables its
   * toggles while saving, so the second write here follows the first rather than
   * overlapping it), and the assertion is on `aria-pressed` rather than on the
   * chip's text: in `stack` the control draws every AVAILABLE label as a toggle,
   * so 'urgent' is on screen whether or not the ticket carries it.
   */
  it('successive same-field saves each roll back to their own starting value', async () => {
    installFetch({
      details: linearDetails(),
      deferPatch: true,
      linearLabels: [
        { id: 'lab-1', name: 'bug' },
        { id: 'lab-2', name: 'urgent' },
      ],
    })
    await renderLens({ provider: 'linear', layout: 'stack' })

    const labelToggle = (name: string) =>
      Array.from(container.querySelectorAll('[data-lens-labels] button')).find(
        (b) => b.getAttribute('aria-label') === name,
      ) as HTMLButtonElement
    const toggle = (name: string) =>
      act(async () => {
        labelToggle(name).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

    // The ticket carries 'bug' only.
    expect(labelToggle('bug').getAttribute('aria-pressed')).toBe('true')
    expect(labelToggle('urgent').getAttribute('aria-pressed')).toBe('false')

    // First write: add 'urgent'. It parks, and travels as the FULL set.
    await toggle('urgent')
    expect(deferred.length).toBe(1)
    expect(deferred[0].body).toEqual({ fields: { label_ids: ['lab-1', 'lab-2'] } })
    expect(labelToggle('urgent').getAttribute('aria-pressed')).toBe('true')

    // Refused → back to the ticket's own single label.
    await releasePatch('labels', {
      status: 200,
      body: { ok: false, code: 'provider_error', error: 'labels refused' },
    })
    expect(labelToggle('bug').getAttribute('aria-pressed')).toBe('true')
    expect(labelToggle('urgent').getAttribute('aria-pressed')).toBe('false')
    expect(toastMock.error).toHaveBeenCalledWith('labels refused')

    // A SECOND write, whose own refusal must roll back to the CURRENT value (one
    // label) rather than to anything the first write left behind.
    await toggle('urgent')
    expect(labelToggle('urgent').getAttribute('aria-pressed')).toBe('true')
    await releasePatch('labels', {
      status: 200,
      body: { ok: false, code: 'provider_error', error: 'again' },
    })
    expect(labelToggle('bug').getAttribute('aria-pressed')).toBe('true')
    expect(labelToggle('urgent').getAttribute('aria-pressed')).toBe('false')
  })

  /**
   * A LENS SWITCH DISCARDS IN-FLIGHT WRITES CLEANLY. Switching providers remounts
   * the lens onto a different ticket; a write aimed at the old one must not
   * reconcile into, roll back inside, or toast over the new one — there is nothing
   * of its left on screen to put back.
   */
  it('a save that lands after a lens switch neither reconciles nor toasts', async () => {
    installFetch({
      details: jiraDetails(),
      deferPatch: true,
      jiraUsers: [
        { account_id: 'acc-1', display_name: 'Ada Lovelace' },
        { account_id: 'acc-2', display_name: 'Grace Hopper' },
      ],
    })
    await renderLens({ provider: 'jira', layout: 'stack' })
    await setSelect('Jira assignee', 'acc-2')
    expect(deferred.length).toBe(1)

    // Flip to Linear — same mount, new provider, new read.
    installFetch({ details: linearDetails(), deferPatch: true })
    // `installFetch` cleared `deferred`, so keep the parked resolver by hand.
    const stale = deferred
    await renderLens({ provider: 'linear', layout: 'stack' })
    expect(chip('team')!.textContent).toContain('Engineering')

    // The old Jira write comes back REFUSED, now.
    await act(async () => {
      stale.forEach((d) => d.resolve({ status: 200, body: { ok: false, error: 'too late' } }))
      await Promise.resolve()
      await Promise.resolve()
    })

    // No toast for a ticket nobody is looking at, and the Linear lens is intact.
    expect(toastMock.error).not.toHaveBeenCalledWith('too late')
    expect(chip('team')!.textContent).toContain('Engineering')
    expect(selectByLabel('Linear assignee')!.value).toBe('lm1')
  })

  /**
   * UNMOUNT IS THE SAME INVALIDATION as a lens switch — the properties view can be
   * closed while a write is in flight (the strip has a Close, the panel navigates
   * away), and a refusal landing afterwards must not toast at a surface nobody is
   * looking at, nor try to roll back inside an unmounted tree.
   */
  it('a save that lands after unmount neither toasts nor warns', async () => {
    installFetch({
      details: jiraDetails(),
      deferPatch: true,
      jiraUsers: [
        { account_id: 'acc-1', display_name: 'Ada Lovelace' },
        { account_id: 'acc-2', display_name: 'Grace Hopper' },
      ],
    })
    await renderLens({ provider: 'jira', layout: 'stack' })
    await setSelect('Jira assignee', 'acc-2')
    const stale = [...deferred]
    expect(stale.length).toBe(1)

    // The properties view closes with the write still out there.
    await act(async () => {
      root.render(null)
    })

    await act(async () => {
      stale.forEach((d) => d.resolve({ status: 200, body: { ok: false, error: 'stale write' } }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(toastMock.error).not.toHaveBeenCalledWith('stale write')
  })
})

describe('TaskLens — failure banners', () => {
  it('reconnect_required offers Settings and nothing to retry', async () => {
    installFetch({
      details: { ok: false, code: 'reconnect_required', error: 'token rejected' },
      detailsStatus: 502,
    })
    const onOpenSettings = vi.fn()
    await renderLens({ provider: 'jira', onOpenSettings })

    const banner = container.querySelector('[data-lens-failure="reconnect"]')!
    expect(banner.textContent).toContain('Reconnect Jira')
    await act(async () => {
      Array.from(banner.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('settings'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpenSettings).toHaveBeenCalledWith('connectors/jira/tasks')
  })

  /**
   * `task_missing` IS RETRYABLE and `task_deleted` IS NOT — the distinction the
   * link markers already draw. Jira's 404 is ambiguous by platform design
   * (deleted, or invisible to this account); an Asana gid that 404s really is
   * gone.
   */
  it('task_missing is retryable, and Retry re-reads the ticket', async () => {
    installFetch({
      details: { ok: false, code: 'task_missing', error: 'Could not find this Jira issue' },
      detailsStatus: 404,
    })
    await renderLens({ provider: 'jira' })

    const banner = container.querySelector('[data-lens-failure="missing"]')!
    expect(banner.textContent).toContain('Could not find this Jira issue')
    const before = calls.filter((c) => c.url.includes('/task-details')).length
    await act(async () => {
      banner.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(calls.filter((c) => c.url.includes('/task-details')).length).toBe(before + 1)
  })

  it('task_deleted is terminal — the message names it, and there is no Retry', async () => {
    installFetch({
      details: { ok: false, code: 'task_deleted', error: 'gone' },
      detailsStatus: 404,
    })
    await renderLens({ provider: 'asana' })

    const banner = container.querySelector('[data-lens-failure="deleted"]')!
    expect(banner.textContent).toContain('This ticket was deleted in Asana')
    expect(banner.querySelector('button')).toBeNull()
  })

  it('provider_error is retryable with the route\'s own message', async () => {
    installFetch({
      details: { ok: false, code: 'provider_error', error: 'Jira returned 429' },
      detailsStatus: 502,
    })
    await renderLens({ provider: 'jira' })
    const banner = container.querySelector('[data-lens-failure="error"]')!
    expect(banner.textContent).toContain('Jira returned 429')
    expect(banner.querySelector('button')!.textContent).toContain('Retry')
  })
})

describe('TaskLens — the strip respects the capture panel\'s width budget', () => {
  /**
   * ~608px, and the reason the compose strip moved to its own row. A chip row of
   * six fields must SCROLL, and `overflow-y-hidden` is not decoration: a lone
   * `overflow-x-auto` computes `overflow-y: auto`, which would make this a
   * vertical scroll container too and let a trackpad flick inside it swallow the
   * capture panel's own scroll.
   */
  it('scrolls horizontally on the compose strip\'s own classes', async () => {
    installFetch({ details: jiraDetails() })
    await renderLens({ provider: 'jira', layout: 'strip' })
    const scroller = container.querySelector('[data-lens-scroller]')!
    expect(scroller.className).toContain('overflow-x-auto')
    expect(scroller.className).toContain('overflow-y-hidden')
  })

  it('stack layout has no scroller — the sidebar is a vertical column', async () => {
    installFetch({ details: jiraDetails() })
    await renderLens({ provider: 'jira', layout: 'stack' })
    expect(container.querySelector('[data-lens-scroller]')).toBeNull()
    expect(container.querySelector('[data-lens-surface="stack"]')).toBeTruthy()
  })
})
