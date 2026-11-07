// @vitest-environment jsdom
/**
 * PushComposePanel — the per-push destination form, INLINE.
 *
 * The form's job is not to render fields; it is to render THE RIGHT fields and
 * to send only what the user actually changed. Both halves are what this file
 * pins:
 *
 *  - FIELDS ARE GATED BY WHAT THE PROVIDER SAYS, not by taste. Jira's create
 *    screen is per project AND per issue type, and a field absent from it 400s
 *    if sent ("not on the appropriate screen"), so `compose-meta` decides
 *    whether a date input exists at all. Asana has no priority field to render.
 *    Linear's priority is static because its scale genuinely is.
 *  - ONLY DIFFERENCES TRAVEL. Entering compose and pressing Create with
 *    nothing touched must produce `{}` — which the route folds to "no
 *    overrides" and pushes down the exact path it took before this form
 *    existed. That is what makes the two-click compose a superset of the
 *    one-click push rather than a replacement for it.
 *
 * The required-custom-field WALL gets its own section: a required field with no
 * selectable values cannot be composed generically, so Create is disabled and
 * Jira's own create screen is offered instead. Creating and praying is the
 * failure mode this exists to prevent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RE-TARGETED FROM THE DIALOG (the inline-compose rework).
 *
 * The component was a `<Dialog open={...}>`; it is now a form rendered directly
 * into the surface's own property view — a horizontal scrolling STRIP on rows,
 * a vertical STACK in the detail-panel sidebar. Liam's words: "I don't want it
 * to be a pop-up. We already have a property view on every action item."
 *
 * The MECHANICAL consequence for every test here is that `open`/`onOpenChange`
 * are gone: entering compose mode is MOUNTING this component and leaving it is
 * unmounting, so the harness renders it unconditionally and `onCancel` is what
 * "close" asserts against. No test's CLAIM changed — the field gating, the
 * override bodies and the wall are all pinned exactly as before, which is the
 * point: this was a re-skin of where compose lives, not of what it sends. The
 * individually-modified tests each carry their own note.
 *
 * Radix's Select can't be driven in jsdom (pointer-capture and ResizeObserver
 * APIs it doesn't implement), so it is replaced with plain elements preserving
 * the contracts the form relies on — the same substitution the
 * settings-destination suites next door already make. The Dialog mock is GONE
 * along with the dialog.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))

// The real cachedJson is a module-level SWR cache — one test's projects would
// be served to every later test in this file.
vi.mock('@/lib/cached-fetch', () => ({
  cachedJson: async (url: string) => {
    const res = await fetch(url)
    return res.ok ? res.json() : null
  },
}))

vi.mock('@/lib/open-external', () => ({ openExternalUrl: vi.fn() }))

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
    // The trigger carries the aria-label the panel identifies fields by, so it
    // has to survive the substitution even though the real one is a button.
    //
    // It now also forwards `className` and renders its children. The chip
    // restyle puts the field's ENTIRE presentation on this element — the
    // pill's height, radius and border, plus the leading icon passed as a
    // child — so a stub that dropped both made every Select-backed field
    // invisible to a styling assertion while the real component was chipped.
    // Nothing about the behavioural suites changes; they read the `<select>`
    // and the `data-select-label`, both untouched.
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

import { PushComposePanel } from '../push-compose-panel'

// ---- fetch fake ------------------------------------------------------------

interface FetchConfig {
  /** `task_sync_state.config` as the settings GET returns it. */
  config?: Record<string, unknown>
  jiraProjects?: Array<{ id: string; key: string; name: string }>
  jiraIssueTypes?: Array<{ id: string; name: string }>
  jiraUsers?: Array<{ account_id: string; display_name: string; email: string | null; active: boolean }>
  jiraMeta?: Record<string, unknown>
  jiraNativeUrl?: string | null
  asanaProjects?: Array<{ gid: string; name: string }>
  asanaSections?: Array<{ gid: string; name: string }>
  asanaUsers?: Array<{ gid: string; name: string; email: string | null }>
  linearTeams?: Array<{ id: string; key: string | null; name: string }>
  linearProjects?: Array<{ id: string; name: string }>
  linearMembers?: Array<{ id: string; name: string; full_name: string | null; email: string | null; avatar_url: string | null }>
  linearLabels?: Array<{ id: string; name: string; color: string | null; scope: string }>
  /** A per-path failure body, keyed by url fragment. */
  fail?: Record<string, { status: number; body: Record<string, unknown> }>
  /**
   * Like `fail`, but the backend can be HEALED mid-test via the returned
   * `heal()`. That is what a transient 500 actually looks like, and it is the
   * only way to prove Retry re-attempts a slot rather than merely re-rendering
   * the same banner: the path must still be failing when the banner appears and
   * healthy when Retry fires.
   */
  failUntilHealed?: Record<string, { status: number; body: Record<string, unknown> }>
  /** Url fragments whose request never settles — an in-flight fetch to cancel. */
  hang?: string[]
}

let calls: string[] = []

/** A createmeta answer with every native present and nothing blocking. */
function fullMeta(overrides: Record<string, unknown> = {}) {
  return {
    has_due_date: true,
    due_date_required: false,
    has_labels: true,
    labels_required: false,
    has_assignee: true,
    assignee_required: false,
    has_priority: true,
    priority_required: false,
    priorities: [
      { id: '1', name: 'Highest' },
      { id: '3', name: 'Medium' },
    ],
    custom_fields: [],
    blocking_fields: [],
    ...overrides,
  }
}

function installFetch(cfg: FetchConfig = {}) {
  calls = []
  const healed = { value: false }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      calls.push(url)

      for (const [fragment, failure] of Object.entries(cfg.fail ?? {})) {
        if (url.includes(fragment)) {
          return { ok: false, status: failure.status, json: async () => failure.body }
        }
      }

      if (!healed.value) {
        for (const [fragment, failure] of Object.entries(cfg.failUntilHealed ?? {})) {
          if (url.includes(fragment)) {
            return { ok: false, status: failure.status, json: async () => failure.body }
          }
        }
      }

      for (const fragment of cfg.hang ?? []) {
        if (url.includes(fragment)) return new Promise(() => {})
      }

      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

      if (url.includes('-settings')) return ok({ connected: true, config: cfg.config ?? {} })
      if (url.includes('/jira/projects')) {
        // The real route FILTERS server-side, and the slot is replaced
        // wholesale with whatever comes back — so the fake has to filter too or
        // a search would be indistinguishable from a browse.
        const q = new URL(url, 'http://x').searchParams.get('query')
        const all = cfg.jiraProjects ?? []
        return ok({
          projects: q
            ? all.filter((p) => `${p.key} ${p.name}`.toLowerCase().includes(q.toLowerCase()))
            : all,
        })
      }
      if (url.includes('/jira/issue-types')) return ok({ issueTypes: cfg.jiraIssueTypes ?? [] })
      if (url.includes('/jira/assignable-users')) return ok({ users: cfg.jiraUsers ?? [] })
      if (url.includes('/jira/compose-meta')) {
        return ok({
          meta: cfg.jiraMeta ?? fullMeta(),
          native_create_url: cfg.jiraNativeUrl ?? null,
          cached: false,
        })
      }
      if (url.includes('/asana/projects')) return ok({ projects: cfg.asanaProjects ?? [] })
      if (url.includes('/asana/sections')) return ok({ sections: cfg.asanaSections ?? [] })
      if (url.includes('/asana/users')) return ok({ users: cfg.asanaUsers ?? [] })
      if (url.includes('/linear/teams')) return ok({ teams: cfg.linearTeams ?? [] })
      if (url.includes('/linear/projects')) return ok({ projects: cfg.linearProjects ?? [] })
      if (url.includes('/linear/members')) return ok({ members: cfg.linearMembers ?? [] })
      if (url.includes('/linear/labels')) return ok({ labels: cfg.linearLabels ?? [] })
      return ok({})
    }),
  )
  /** Make every `failUntilHealed` path healthy from the next request onward. */
  return { heal: () => { healed.value = true } }
}

// ---- harness ---------------------------------------------------------------

let container: HTMLDivElement
let root: Root

/**
 * Mount the form the way a surface does — unconditionally, because MOUNTING is
 * what entering compose mode means now.
 *
 * `onCancel` stands in for the dialog's `onOpenChange(false)`: it is the one
 * signal that says "leave compose mode", fired by the X, by Escape, and by the
 * caller after a successful Create.
 */
async function render(props: Partial<Parameters<typeof PushComposePanel>[0]> = {}) {
  const onCreate = props.onCreate ?? vi.fn(async () => true)
  await act(async () => {
    root.render(
      h(PushComposePanel, {
        provider: 'jira',
        providerName: 'Jira',
        defaultTitle: 'Ship the thing',
        onCancel: vi.fn(),
        ...props,
        onCreate,
      }),
    )
  })
  return onCreate
}

/** Render into a stand-in ROW that carries the surface's own gestures. */
async function renderInRow(
  props: Partial<Parameters<typeof PushComposePanel>[0]> = {},
  rowHandlers: { onClick?: () => void; onPointerDown?: () => void } = {},
) {
  const onCreate = props.onCreate ?? vi.fn(async () => true)
  await act(async () => {
    root.render(
      h(
        'div',
        rowHandlers,
        h(PushComposePanel, {
          provider: 'jira',
          providerName: 'Jira',
          defaultTitle: 'Ship the thing',
          onCancel: vi.fn(),
          ...props,
          onCreate,
        }),
        h('span', { 'data-row-body': '' }, 'the rest of the row'),
      ),
    )
  })
  return onCreate
}

function selectByLabel(label: string): HTMLSelectElement | undefined {
  const marker = Array.from(container.querySelectorAll('[data-select-label]')).find(
    (el) => el.getAttribute('data-select-label') === label,
  )
  // The substitute trigger is a sibling INSIDE the <select>, so the select is
  // its closest ancestor of that tag.
  return marker?.closest('select') as HTMLSelectElement | undefined
}

function inputByLabel(label: string): HTMLInputElement | undefined {
  return Array.from(container.querySelectorAll('input')).find(
    (i) => i.getAttribute('aria-label') === label,
  )
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined
}

/** The Create button — the LAST one carrying the create copy (link-out shares it). */
function createButton(): HTMLButtonElement {
  const matches = Array.from(container.querySelectorAll('button')).filter((b) =>
    b.textContent?.trim().startsWith('Create in'),
  ) as HTMLButtonElement[]
  return matches[matches.length - 1]
}

async function setSelect(label: string, value: string) {
  const select = selectByLabel(label)!
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function setInput(label: string, value: string) {
  const input = inputByLabel(label)!
  await act(async () => {
    // React tracks the previous value on the node; bypass its setter or the
    // synthetic change event is swallowed as a no-op.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function clickCreate() {
  await act(async () => {
    createButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/**
 * THE DATE CHIP, which in `strip` is Dial8's own `DateTimePicker` rather than
 * an `<input type="date">`.
 *
 * The field keeps its accessible name through a labelled group wrapper (the
 * shared picker takes no `aria-label`), so it is still found BY NAME — the
 * handle every one of these tests already used. `stack` keeps the native input,
 * which is why `dateInput` below still exists for that layout.
 */
function dateChip(label: string): HTMLButtonElement | undefined {
  const group = Array.from(container.querySelectorAll('[data-compose-date]')).find(
    (el) => el.getAttribute('data-compose-date') === label,
  )
  return group?.querySelector('button') as HTMLButtonElement | undefined
}

/** The native date input — `stack` layout only. */
function dateInput(label: string): HTMLInputElement | undefined {
  return Array.from(container.querySelectorAll('input[type="date"]')).find(
    (i) => i.getAttribute('aria-label') === label,
  ) as HTMLInputElement | undefined
}

/**
 * Clear the date chip.
 *
 * The calendar cannot emit "no date", so the chip carries an X beside it — the
 * same pairing the proposal card's own due-date pill uses. Clearing is not a
 * cosmetic affordance: an explicit null is what suppresses the push's fallback,
 * which the "travels as null" tests below pin.
 */
async function clearDate(label: string) {
  const group = Array.from(container.querySelectorAll('[data-compose-date]')).find(
    (el) => el.getAttribute('data-compose-date') === label,
  )!
  const clear = Array.from(group.querySelectorAll('button')).find((b) =>
    b.getAttribute('aria-label')?.startsWith('Clear'),
  )!
  await act(async () => {
    clear.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/**
 * Pick a date through the REAL calendar, the way a user does.
 *
 * Deliberately not a shortcut that calls `onChange` with a Date: the whole
 * claim these tests carry is that the picker's own output reaches the wire as
 * the right `YYYY-MM-DD`, so the day cell is clicked and the conversion is
 * exercised end to end. The wire string is passed in and the cell is located by
 * its day number within the month the picker opens on (seeded from `value`, or
 * today when unset — so the month is navigated by setting the year/month
 * selects the calendar header renders).
 */
async function pickDate(label: string, wire: string) {
  const [y, m, d] = wire.split('-').map(Number)
  await act(async () => {
    dateChip(label)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  // The calendar is portalled to the body, and its header carries a month and a
  // year <select> (rendered as plain selects by this file's Select stub). Order
  // matters: the year first, because changing the month re-renders the header.
  const headerSelects = () =>
    Array.from(document.querySelectorAll('select')).filter((s) =>
      Array.from(s.options).some((o) => o.textContent === 'January' || o.textContent === String(y)),
    )
  const yearSelect = headerSelects().find((s) =>
    Array.from(s.options).some((o) => o.textContent === String(y)),
  )
  if (yearSelect) {
    await act(async () => {
      yearSelect.value = String(y)
      yearSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  const monthSelect = headerSelects().find((s) =>
    Array.from(s.options).some((o) => o.textContent === 'January'),
  )
  if (monthSelect) {
    await act(async () => {
      monthSelect.value = String(m - 1)
      monthSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  /**
   * The day cell, found by its FULL DATE rather than its number.
   *
   * `showOutsideDays` means the grid also renders the neighbouring months'
   * spill-over — a September view carries an "October 1" cell too, so matching
   * on the text "1" picks whichever comes first in the DOM and silently sets
   * the wrong month. react-day-picker gives every cell an `aria-label` naming
   * the whole date; matching the day and the month name together is unambiguous.
   */
  const monthName = new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long' })
  const cell = Array.from(document.querySelectorAll('button')).find((b) => {
    const name = b.getAttribute('aria-label') ?? ''
    return (
      name.includes(monthName) &&
      name.includes(String(y)) &&
      new RegExp(`\\b${d}(st|nd|rd|th)\\b`).test(name)
    )
  })!
  await act(async () => {
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  // CLOSE IT AGAIN, by clicking the trigger. The calendar does not dismiss
  // itself on select, and Radix keeps the portalled content in the document
  // while open — so a second `pickDate` in the same test would search a
  // document holding two calendars and match the stale one.
  //
  // NOT Escape, even though a user could: the strip binds Escape to LEAVING
  // COMPOSE, so closing the popover that way would also fire `onCancel`. In
  // these tests `onCancel` is a spy that does not unmount, so the helper would
  // appear to work while quietly cancelling the form under every assertion
  // that followed it.
  await act(async () => {
    dateChip(label)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/**
 * Where the project list can be found.
 *
 * DOCUMENT, not `container`, and that is the whole point of the portal fix: in
 * `strip` the popover's content is portalled to the body so it can escape the
 * scroller's clipping, which puts it OUTSIDE the render container. `stack`
 * still renders the list inline (inside `container`), and the document is a
 * superset of both — so every helper below reads the same in either layout.
 * Safe because each test mounts exactly one form.
 */
function pickerScope(): Document {
  return document
}

/**
 * Open the strip's project picker.
 *
 * RE-TARGET NOTE: in the dialog the `SearchableOptionList` was rendered inline —
 * a 200px-tall list box, which the strip cannot hold (its whole contract is a
 * stable single-line height). In `strip` layout the same list moved behind a
 * field-shaped trigger. `stack` still renders it inline, so this is a no-op
 * there and every helper below works in both layouts.
 */
async function openProjectPicker() {
  const trigger = container.querySelector('[data-compose-project-trigger]') as HTMLButtonElement | null
  // Already open, or `stack` layout where the list is always inline.
  if (!trigger || pickerScope().querySelector('input[placeholder="Search projects..."]')) return
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/**
 * The Linear label toggles, opening their chip first if they are behind one.
 *
 * RE-TARGET NOTE (chip idiom): in `strip` the label toggles used to spill
 * directly onto the row inside their own horizontal scroller — a scroller
 * nested in the strip's scroller, on the same axis, whose width grew with the
 * team's label count and broke the row's uniformity. They now live behind a
 * single summary chip ("Labels" / "Bug" / "3 labels") in a portalled popover.
 * The TOGGLES THEMSELVES are unchanged — same markup, same `aria-pressed`, same
 * `data-linear-labels` container — so every assertion below still drives the
 * real control; only reaching it costs one click. `stack` renders them inline,
 * where this is a no-op.
 */
async function labelToggles(): Promise<Element> {
  const existing = pickerScope().querySelector('[data-linear-labels]')
  if (existing) return existing
  const trigger = container.querySelector(
    '[data-compose-labels-trigger]',
  ) as HTMLButtonElement | null
  if (trigger) {
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  return pickerScope().querySelector('[data-linear-labels]')!
}

/** Pick a project from the SearchableOptionList (a plain button list). */
async function pickProject(name: string) {
  await openProjectPicker()
  const button = Array.from(pickerScope().querySelectorAll('button')).find(
    (b) => b.textContent?.includes(name) && !b.hasAttribute('data-compose-project-trigger'),
  )!
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The project picker's search box. */
function searchInput(): HTMLInputElement {
  return pickerScope().querySelector('input[placeholder="Search projects..."]') as HTMLInputElement
}

/**
 * The names currently OFFERED by the open project list.
 *
 * Scoped to exclude the TRIGGER rather than read everything, because the
 * strip's trigger also renders the selected project's name — an unfiltered
 * read cannot tell "offered as an option" from "already picked".
 *
 * NOTE: the separator below was a literal NUL byte (`\0`) until this pass — a
 * stray control character that made the whole FILE read as binary. Behaviour
 * was unaffected (every caller does a single-name `toContain`), but `grep` and
 * `file` both classified 2000 lines of tests as `data` and silently reported
 * ZERO matches for any pattern searched here. Repaired to the plain space it
 * was always meant to be.
 */
function projectOptionNames(): string {
  return Array.from(pickerScope().querySelectorAll('button'))
    .filter((b) => !b.hasAttribute('data-compose-project-trigger'))
    .map((b) => b.textContent ?? '')
    .join(' ')
}

/** Type into the project search and let its 250ms debounce fire. */
async function typeSearch(query: string) {
  await openProjectPicker()
  await act(async () => {
    const input = searchInput()
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // Real timers: the search is debounced 250ms and this file does not fake
  // timers (40 other tests rely on real microtask flushing).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 320))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// ---- prefill + the untouched push ------------------------------------------

describe('PushComposePanel — prefilled from the workspace config', () => {
  it('opens on the configured project and issue type', async () => {
    installFetch({
      config: {
        cloud_id: 'cloud-1',
        site_name: 'Acme',
        project_id: '10001',
        project_key: 'ENG',
        issue_type_id: '10100',
      },
      jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
      jiraIssueTypes: [
        { id: '10100', name: 'Task' },
        { id: '10101', name: 'Bug' },
      ],
    })
    await render()

    expect(selectByLabel('Issue type')!.value).toBe('10100')

    /**
     * RE-TARGETED, twice over — both halves of this assertion named UI that is
     * deliberately gone.
     *
     * THE TITLE FIELD. The strip no longer offers one: the card already renders
     * the title (as its heading beside the platform mark, as the panel header
     * in the sidebar), so a title chip showed the same string twice and invited
     * the user to edit the copy that was not the one they were looking at. The
     * prefill claim it was making now belongs to the project/issue-type
     * assertions around it; `overrides.title` staying off the wire is pinned
     * directly in the Create section.
     *
     * THE SITE CAPTION. "In {site}" was a leading label for a value v1 cannot
     * change, and on a Jira site named after the workspace it read as noise
     * rather than context. The fact survives where it is useful — as the
     * tooltip on the Project chip, i.e. the field the site actually scopes —
     * which is where this now reads it.
     */
    expect(inputByLabel('Title')).toBeUndefined()
    const project = container.querySelector('[data-compose-project-trigger]')!
    expect(project.getAttribute('title')).toBe('In Acme')
  })

  it('AN UNTOUCHED PANEL SENDS NOTHING — the config path, byte for byte', async () => {
    // This is the whole compatibility claim. Open, Create, and the push is the
    // one-click push it replaced.
    installFetch({
      config: { cloud_id: 'cloud-1', project_id: '10001', project_key: 'ENG', issue_type_id: '10100' },
      jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
      jiraIssueTypes: [{ id: '10100', name: 'Task' }],
    })
    const onCreate = await render()
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({})
  })

  /**
   * RE-TARGETED, and INVERTED — deliberately.
   *
   * This used to be "an edited title travels", driving a title input the strip
   * owned. That field is gone (the card renders the title; compose swaps only
   * the property row beneath it), so there is no longer a user edit that could
   * produce a title override, and the honest claim is the opposite one: this
   * form NEVER puts a title on the wire, whatever the action is called.
   *
   * `overrides.title` remains a valid key at the API — the push routes and the
   * MCP/AI callers still set it — which is exactly why this needs pinning
   * rather than deleting: a well-meaning future change could re-add a title to
   * `buildOverrides` from `defaultTitle` and nothing else would object.
   */
  it('NEVER sends a title override — the card owns the title', async () => {
    installFetch({
      config: { cloud_id: 'cloud-1', project_id: '10001', project_key: 'ENG', issue_type_id: '10100' },
      jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
      jiraIssueTypes: [{ id: '10100', name: 'Task' }],
    })
    const onCreate = await render({ defaultTitle: 'Ship the thing' })

    // No title control of any kind in the strip.
    expect(inputByLabel('Title')).toBeUndefined()
    expect(container.querySelector('[data-compose-field="Title"]')).toBeNull()

    // And a push that changes something else still carries no title key.
    await setSelect('Issue type', '10100')
    await clickCreate()
    const overrides = (onCreate as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect('title' in overrides).toBe(false)
  })

  /**
   * RE-TARGETED (was: "loads NOTHING until it is open", rendered with
   * `open: false`).
   *
   * The `open` prop is gone — compose mode IS this component's lifetime, so
   * "not open" is "not rendered" and there is no prop to pass. The claim it was
   * protecting is unchanged and matters more than ever now that every row on a
   * 500-row board can host one: nothing loads until a user actually picks a
   * destination. Asserted at the SURFACE it now belongs to — a mounted menu
   * that nobody has composed with issues no option request at all.
   */
  it('loads NOTHING for a surface that is not composing', async () => {
    installFetch({ config: {} })
    await act(async () => {
      root.render(h('div', {}, 'a row with no compose form'))
    })
    expect(calls).toHaveLength(0)
  })
})

// ---- Jira: fields gated by the create screen -------------------------------

describe('PushComposePanel — Jira fields follow compose-meta', () => {
  const BASE = {
    config: { cloud_id: 'cloud-1', project_id: '10001', project_key: 'ENG', issue_type_id: '10100' },
    jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
    jiraIssueTypes: [{ id: '10100', name: 'Task' }],
  }

  it('renders the natives the screen holds', async () => {
    installFetch({ ...BASE, jiraMeta: fullMeta() })
    await render()
    expect(selectByLabel('Assignee')).toBeTruthy()
    expect(selectByLabel('Priority')).toBeTruthy()
    // RE-TARGETED: the strip's date field is Dial8's `DateTimePicker` (a
    // labelled group around a popover trigger), not an `<input type="date">`.
    // The claim — the field the create screen holds is rendered — is unchanged.
    expect(dateChip('Due date')).toBeTruthy()
    expect(inputByLabel('Labels')).toBeTruthy()
  })

  it('HIDES the due-date input when `duedate` is not on the screen', async () => {
    // Sending it anyway is the documented 400: "Field 'duedate' cannot be set.
    // It is not on the appropriate screen, or unknown."
    installFetch({ ...BASE, jiraMeta: fullMeta({ has_due_date: false }) })
    await render()
    // RE-TARGETED to the picker chip; the gating claim is untouched.
    expect(dateChip('Due date')).toBeUndefined()
  })

  it('hides labels, priority and assignee the same way', async () => {
    installFetch({
      ...BASE,
      jiraMeta: fullMeta({ has_labels: false, has_priority: false, has_assignee: false }),
    })
    await render()
    expect(inputByLabel('Labels')).toBeUndefined()
    expect(selectByLabel('Priority')).toBeUndefined()
    expect(selectByLabel('Assignee')).toBeUndefined()
  })

  it('takes its priorities from createmeta, never from a priority list', async () => {
    // /priority/search needs manage:jira-configuration, a scope Dial8 doesn't
    // hold — so the allowedValues on the priority field ARE the answer.
    installFetch({ ...BASE, jiraMeta: fullMeta() })
    await render()
    const options = Array.from(selectByLabel('Priority')!.querySelectorAll('option')).map(
      (o) => o.textContent,
    )
    expect(options).toContain('Highest')
    expect(options).toContain('Medium')
    expect(calls.some((c) => c.includes('priority/search'))).toBe(false)
  })

  it('sends the chosen natives as overrides', async () => {
    installFetch({
      ...BASE,
      jiraMeta: fullMeta(),
      jiraUsers: [
        { account_id: 'acc-1', display_name: 'Ada Lovelace', email: 'ada@acme.com', active: true },
      ],
    })
    const onCreate = await render()
    await setSelect('Assignee', 'acc-1')
    await setSelect('Priority', '1')
    // RE-TARGETED: picked in the calendar rather than typed. The asserted wire
    // value below is unchanged, which is the point — the new control produces
    // the same `YYYY-MM-DD` the native input did.
    await pickDate('Due date', '2026-09-01')
    await setInput('Labels', 'backend, q3')
    await clickCreate()

    expect(onCreate).toHaveBeenCalledWith({
      // accountId, never email — Jira blanks emailAddress per the target user's
      // privacy setting while accountId is always populated.
      assignee_account_id: 'acc-1',
      priority_id: '1',
      due_date: '2026-09-01',
      labels: ['backend', 'q3'],
    })
  })

  it('OVERRIDING THE PROJECT CARRIES ITS ISSUE TYPE', async () => {
    // Jira issue types are per-project copies, so the config's type is not valid
    // in another project — the route rejects the pair, and producing it would be
    // the panel's bug rather than the user's.
    installFetch({
      ...BASE,
      jiraProjects: [
        { id: '10001', key: 'ENG', name: 'Engineering' },
        { id: '10002', key: 'DES', name: 'Design' },
      ],
      jiraIssueTypes: [{ id: '10100', name: 'Task' }],
    })
    const onCreate = await render()
    await pickProject('Design')
    await setSelect('Issue type', '10100')
    await clickCreate()

    expect(onCreate).toHaveBeenCalledWith({
      project_id: '10002',
      project_key: 'DES',
      issue_type_id: '10100',
    })
  })

  it('a project change CLEARS the issue type rather than carrying it across', async () => {
    // "Task" in one project is a DIFFERENT id from "Task" in the next, so
    // carrying the old id over would push into the new project with an issue
    // type it has never heard of.
    //
    // Asserted through Create rather than through the <select>'s value: the
    // native-select substitute this file mocks Radix down to auto-selects its
    // first option when handed an empty value, so the DOM would read '10100'
    // even with the component's state correctly null.
    installFetch({
      ...BASE,
      jiraProjects: [
        { id: '10001', key: 'ENG', name: 'Engineering' },
        { id: '10002', key: 'DES', name: 'Design' },
      ],
    })
    const onCreate = await render()
    expect(createButton().disabled).toBe(false)

    await pickProject('Design')
    expect(createButton().disabled).toBe(true)
    expect(container.textContent).toContain('Pick an issue type')
    await clickCreate()
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('re-reads the create screen when the issue type changes', async () => {
    installFetch({
      ...BASE,
      jiraIssueTypes: [
        { id: '10100', name: 'Task' },
        { id: '10101', name: 'Bug' },
      ],
    })
    await render()
    const before = calls.filter((c) => c.includes('compose-meta')).length
    await setSelect('Issue type', '10101')
    const after = calls.filter((c) => c.includes('compose-meta')).length
    expect(after).toBeGreaterThan(before)
    expect(calls.some((c) => c.includes('issueTypeId=10101'))).toBe(true)
  })
})

// ---- the required-custom-field wall ----------------------------------------

describe('PushComposePanel — the required-field wall', () => {
  const BASE = {
    config: {
      cloud_id: 'cloud-1',
      site_url: 'https://acme.atlassian.net',
      project_id: '10001',
      project_key: 'ENG',
      issue_type_id: '10100',
    },
    jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
    jiraIssueTypes: [{ id: '10100', name: 'Task' }],
  }

  it('a required custom field WITH values becomes a dropdown', async () => {
    installFetch({
      ...BASE,
      jiraMeta: fullMeta({
        custom_fields: [
          {
            field_id: 'customfield_10041',
            name: 'Team',
            required: true,
            options: [{ id: 'opt-1', name: 'Platform' }],
          },
        ],
      }),
    })
    const onCreate = await render()
    expect(selectByLabel('Team')).toBeTruthy()
    // Required, so Create waits for it.
    expect(createButton().disabled).toBe(true)
    expect(container.textContent).toContain('Team is required')

    await setSelect('Team', 'opt-1')
    expect(createButton().disabled).toBe(false)
    await clickCreate()
    // `{ id }` is Jira's own option-reference shape and the only one the
    // override parser accepts.
    expect(onCreate).toHaveBeenCalledWith({
      custom_fields: { customfield_10041: { id: 'opt-1' } },
    })
  })

  it('A BLOCKING FIELD DISABLES CREATE and names it', async () => {
    installFetch({
      ...BASE,
      jiraNativeUrl: 'https://acme.atlassian.net/secure/CreateIssue.jspa?pid=10001&issuetype=10100',
      jiraMeta: fullMeta({
        blocking_fields: [{ field_id: 'customfield_10099', name: 'Sprint', schema_type: 'array' }],
      }),
    })
    const onCreate = await render()

    expect(container.querySelector('[data-jira-blocking-wall]')).toBeTruthy()
    expect(container.textContent).toContain('Sprint')
    expect(createButton().disabled).toBe(true)
    await clickCreate()
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('offers Jira’s own create screen as the way through the wall', async () => {
    const nativeUrl =
      'https://acme.atlassian.net/secure/CreateIssue.jspa?pid=10001&issuetype=10100'
    installFetch({
      ...BASE,
      jiraNativeUrl: nativeUrl,
      jiraMeta: fullMeta({
        blocking_fields: [{ field_id: 'customfield_10099', name: 'Sprint', schema_type: 'array' }],
      }),
    })
    await render()

    const { openExternalUrl } = await import('@/lib/open-external')
    // Two buttons carry create copy when the wall is up; the link-out is the
    // first, the disabled Create the last.
    const linkOut = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('Create in Jira'),
    )[0]
    await act(async () => {
      linkOut.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(openExternalUrl).toHaveBeenCalledWith(nativeUrl)
  })

  it('shows NO link-out when the site url is unknown (a 404 is worse than nothing)', async () => {
    installFetch({
      ...BASE,
      jiraNativeUrl: null,
      jiraMeta: fullMeta({
        blocking_fields: [{ field_id: 'customfield_10099', name: 'Sprint', schema_type: 'array' }],
      }),
    })
    await render()
    expect(container.querySelector('[data-jira-blocking-wall]')).toBeTruthy()
    const createButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('Create in Jira'),
    )
    expect(createButtons).toHaveLength(1)
    expect(createButtons[0].disabled).toBe(true)
  })

  it('CREATE WAITS for the create screen — an unread wall is not an absent one', async () => {
    // A compose-meta that never answered leaves the wall UNKNOWN, and a create
    // that proceeds in ignorance is the create-and-pray the wall exists to
    // prevent. So a failed read raises the banner and holds Create rather than
    // degrading into "no requirements".
    installFetch({
      ...BASE,
      fail: { 'compose-meta': { status: 500, body: { error: 'Jira is down' } } },
    })
    const onCreate = await render()

    expect(container.textContent).toContain('Jira is down')
    expect(createButton().disabled).toBe(true)
    await clickCreate()
    expect(onCreate).not.toHaveBeenCalled()
  })

  // RE-TARGETED: the due date is picked through Dial8's own calendar rather
  // than typed into a native date input. Same claim — a required date holds
  // Create until answered — driven through the control the strip now renders.
  it('a required NATIVE also holds Create until it is answered', async () => {
    installFetch({ ...BASE, jiraMeta: fullMeta({ due_date_required: true }) })
    await render()
    expect(createButton().disabled).toBe(true)
    expect(container.textContent).toContain('A due date is required')
    await pickDate('Due date', '2026-09-01')
    expect(createButton().disabled).toBe(false)
  })
})

// ---- Asana ------------------------------------------------------------------

describe('PushComposePanel — Asana', () => {
  const BASE = {
    config: { asana_workspace_gid: 'ws-gid', project_gid: 'proj-1', project_name: 'Engineering' },
    asanaProjects: [
      { gid: 'proj-1', name: 'Engineering' },
      { gid: 'proj-2', name: 'Design' },
    ],
    asanaSections: [{ gid: 'sec-1', name: 'In progress' }],
    asanaUsers: [{ gid: 'user-1', name: 'Ada Lovelace', email: 'ada@acme.com' }],
  }

  async function renderAsana(props = {}) {
    return render({ provider: 'asana', providerName: 'Asana', ...props })
  }

  it('HAS NO PRIORITY FIELD — Asana has no such thing to write to', async () => {
    // Not an omission: priority in Asana is a per-project enum custom field or
    // nothing, and a generic "Priority" dropdown would write to whichever field
    // happened to be named that in the project the user picked.
    installFetch(BASE)
    await renderAsana()
    expect(selectByLabel('Priority')).toBeUndefined()
  })

  /**
   * RE-TARGETED: "date-only" was asserted as `type="date"` on the native input,
   * which is gone from `strip` — the field is now Dial8's own `DateTimePicker`.
   * The CLAIM is the one that mattered and it is stated more directly: the
   * picker offers a day and NO time, which is what `due_on` (a calendar date)
   * requires. `granularity="day"` is what suppresses the time row, so its
   * absence is the assertion.
   */
  it('offers project, section, assignee and a date-only due', async () => {
    installFetch(BASE)
    await renderAsana()
    expect(selectByLabel('Section')).toBeTruthy()
    expect(selectByLabel('Assignee')).toBeTruthy()
    expect(dateChip('Due date')).toBeTruthy()

    await act(async () => {
      dateChip('Due date')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // A calendar, and nothing that could set an hour.
    expect(document.querySelector('.rdp, [role="grid"]')).toBeTruthy()
    expect(document.querySelector('#datetime-picker-hour-input')).toBeFalsy()
  })

  it('sends gid-keyed choices and `due_on`, never `due_at`', async () => {
    installFetch(BASE)
    const onCreate = await renderAsana()
    await setSelect('Assignee', 'user-1')
    // RE-TARGETED to the calendar; the `due_on` wire value is unchanged.
    await pickDate('Due date', '2026-09-01')
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({ assignee_gid: 'user-1', due_on: '2026-09-01' })
  })

  it('OVERRIDING THE PROJECT re-offers sections from the NEW project and says the mapping is off', async () => {
    // A section gid belongs to exactly one project, so the workspace's section
    // map is meaningless the moment the project changes — the push suppresses
    // it server-side, and the panel says so rather than leaving the user to
    // wonder where their column went.
    //
    // RE-TARGETED (chip idiom): the CLAIM is unchanged — the panel still tells
    // the user the mapping is off — but in `strip` a hint has nowhere to be
    // rendered as text. A chip row is one line of uniform pills; the second
    // line the hint used to occupy is what made the strip's bottom edge ragged.
    // So the hint became the field's `title`, which is where the assertion now
    // reads it from. `stack` still renders it as visible text (covered by the
    // layout suite below), so this is a strip-only relocation, not a loss.
    installFetch(BASE)
    await renderAsana()
    await pickProject('Design')
    expect(calls.some((c) => c.includes('/asana/sections?project=proj-2'))).toBe(true)
    const section = container.querySelector('[data-compose-field="Section"]')
    expect(section?.getAttribute('title')).toContain("section mapping doesn't apply here")
  })

  it('a project change clears a section picked under the old project', async () => {
    installFetch(BASE)
    const onCreate = await renderAsana()
    await setSelect('Section', 'sec-1')
    await pickProject('Design')
    await clickCreate()
    // The project travels; the stale section does not.
    expect(onCreate).toHaveBeenCalledWith({ project_gid: 'proj-2' })
  })
})

// ---- Linear -----------------------------------------------------------------

describe('PushComposePanel — Linear', () => {
  const BASE = {
    config: { team_id: 'team-1', team_name: 'Engineering', project_id: 'lproj-1' },
    linearTeams: [
      { id: 'team-1', key: 'ENG', name: 'Engineering' },
      { id: 'team-2', key: 'DES', name: 'Design' },
    ],
    linearProjects: [{ id: 'lproj-1', name: 'Q3 Launch' }],
    linearMembers: [
      { id: 'u-1', name: 'ada', full_name: 'Ada Lovelace', email: 'ada@acme.com', avatar_url: null },
    ],
    linearLabels: [
      { id: 'lab-1', name: 'Bug', color: '#f00', scope: 'team' },
      { id: 'lab-2', name: 'Urgent', color: null, scope: 'workspace' },
    ],
  }

  async function renderLinear(props = {}) {
    return render({ provider: 'linear', providerName: 'Linear', ...props })
  }

  it('HAS NO WORKFLOW-STATE FIELD — the push derives it from the team', async () => {
    // A Linear workflow state belongs to exactly one team, so asking the user to
    // pick one would be asking them to know that. resolveStartState re-derives
    // the chosen team's own not-started state server-side.
    installFetch(BASE)
    await renderLinear()
    expect(selectByLabel('Status')).toBeUndefined()
    expect(selectByLabel('State')).toBeUndefined()
  })

  it('offers the STATIC 0-4 priority scale without asking Linear for it', async () => {
    installFetch(BASE)
    await renderLinear()
    const options = Array.from(selectByLabel('Priority')!.querySelectorAll('option')).map(
      (o) => o.textContent,
    )
    expect(options).toEqual(['Team default', 'No priority', 'Urgent', 'High', 'Medium', 'Low'])
  })

  it('sends priority as the Int, not the label', async () => {
    installFetch(BASE)
    const onCreate = await renderLinear()
    await setSelect('Priority', '1')
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({ priority: 1 })
  })

  it('sends 0 ("No priority") as a real choice, not as absent', async () => {
    installFetch(BASE)
    const onCreate = await renderLinear()
    await setSelect('Priority', '0')
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({ priority: 0 })
  })

  it('renders labels as a multiselect and sends label_ids', async () => {
    installFetch(BASE)
    const onCreate = await renderLinear()
    const chips = await labelToggles()
    const bug = Array.from(chips.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Bug'),
    )!
    await act(async () => {
      bug.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({ label_ids: ['lab-1'] })
  })

  it('scopes labels to the chosen team (a workspace-wide list would offer illegal ones)', async () => {
    installFetch(BASE)
    await renderLinear()
    expect(calls.some((c) => c === '/api/account/linear/labels?teamId=team-1')).toBe(true)
  })

  it('A TEAM CHANGE drops the project, assignee and labels chosen under the old one', async () => {
    // Linear projects are many-to-many with teams, so the old project may simply
    // not be associated with the new team and issueCreate would reject it.
    installFetch(BASE)
    const onCreate = await renderLinear()
    const chips = await labelToggles()
    await act(async () => {
      Array.from(chips.querySelectorAll('button'))[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    await setSelect('Team', 'team-2')
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({ team_id: 'team-2' })
  })

  it('re-reads members and labels for the new team', async () => {
    installFetch(BASE)
    await renderLinear()
    await setSelect('Team', 'team-2')
    expect(calls.some((c) => c.includes('/linear/members?teamId=team-2'))).toBe(true)
    expect(calls.some((c) => c.includes('/linear/labels?teamId=team-2'))).toBe(true)
  })
})

/**
 * REGRESSION (review finding: "Explicit 'None'/cleared field choices silently
 * revert to config- or action-derived values").
 *
 * The panel sends only DIFFERENCES, and a cleared field produced no key — which
 * every push reads as "inherit", so the config's project or the action's own
 * assignee/due date came back. The form said one thing and Create did another.
 * A cleared field the user TOUCHED now travels as an explicit null; one they
 * never touched is still omitted, which is what keeps an untouched panel at {}.
 */
describe('PushComposePanel — clearing a prefilled field', () => {
  const LINEAR_BASE = {
    config: { team_id: 'team-1', project_id: 'proj-A' },
    linearTeams: [{ id: 'team-1', key: 'ENG', name: 'Engineering' }],
    linearProjects: [{ id: 'proj-A', name: 'Roadmap' }],
  }

  it('sends project_id: null when the user picks "No project" over a configured one', async () => {
    installFetch(LINEAR_BASE)
    const onCreate = await render({ provider: 'linear', providerName: 'Linear' })

    await act(async () => {
      const select = selectByLabel('Project')!
      select.value = '__none__'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await clickCreate()

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ project_id: null }))
  })

  it('an UNTOUCHED panel still sends {} — no nulls invented', async () => {
    // The byte-compatibility rule. A panel opened and Created without a single
    // interaction must post no body at all.
    installFetch(LINEAR_BASE)
    const onCreate = await render({ provider: 'linear', providerName: 'Linear' })
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({})
  })

  it('sends assignee_id: null when the assignee is explicitly set to Unassigned', async () => {
    installFetch({
      ...LINEAR_BASE,
      linearMembers: [
        { id: 'u-1', name: 'ada', full_name: 'Ada', email: null, avatar_url: null },
      ],
    })
    const onCreate = await render({ provider: 'linear', providerName: 'Linear' })

    await act(async () => {
      const select = selectByLabel('Assignee')!
      select.value = '__none__'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await clickCreate()

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ assignee_id: null }))
  })
})

// ---- failures ---------------------------------------------------------------

describe('PushComposePanel — when the options cannot load', () => {
  it('a reconnect code REPLACES the fields with the reconnect banner', async () => {
    // Empty dropdowns with no explanation read as "you have no projects" — the
    // exact bug the settings pickers already learned not to have.
    installFetch({
      config: { cloud_id: 'cloud-1' },
      fail: {
        '/jira/projects': { status: 400, body: { error: 'Reconnect Jira', code: 'reconnect_required' } },
      },
    })
    await render()
    expect(container.textContent).toContain('Reconnect Jira to compose')
    expect(createButton().disabled).toBe(true)
  })

  it('treats not_connected as the same conclusion — reconnect', async () => {
    installFetch({
      config: { cloud_id: 'cloud-1' },
      fail: {
        '/jira/projects': { status: 400, body: { error: 'No Jira', code: 'not_connected' } },
      },
    })
    await render()
    expect(container.textContent).toContain('Reconnect Jira to compose')
  })

  it('points a reconnect at the provider’s own settings page', async () => {
    installFetch({
      config: { cloud_id: 'cloud-1' },
      fail: {
        '/jira/projects': { status: 400, body: { error: 'x', code: 'reconnect_required' } },
      },
    })
    const onOpenSettings = vi.fn()
    await render({ onOpenSettings })
    await act(async () => {
      buttonByText('Open Jira settings')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpenSettings).toHaveBeenCalledWith('connectors/jira/tasks')
  })

  it('any OTHER failure is a retryable message, not a reconnect', async () => {
    installFetch({
      config: { cloud_id: 'cloud-1' },
      fail: { '/jira/projects': { status: 500, body: { error: 'Jira is down' } } },
    })
    await render()
    expect(container.textContent).toContain('Jira is down')
    expect(container.textContent).not.toContain('Reconnect Jira to compose')
    expect(buttonByText('Retry')).toBeTruthy()
  })

  /**
   * REGRESSION (review finding: "Jira 'Reading create screen' spinner sticks on
   * after a project change cancels the meta fetch").
   *
   * Changing the project nulls the issue type, so the compose-meta effect
   * re-runs and early-returns — but the abandoned fetch's `finally` is skipped
   * (it checks `cancelled`), and the early return reset only `jiraMeta`. The
   * loading flag stayed true with no request in flight, leaving "Reading this
   * issue type's create screen…" on screen permanently. Every re-run that does
   * NOT start a fetch has to leave the flag false.
   */
  it('clears the create-screen spinner when a project change cancels the meta fetch', async () => {
    installFetch({
      config: { cloud_id: 'cloud-1', project_id: '10001', project_key: 'ENG', issue_type_id: '10100' },
      jiraProjects: [
        { id: '10001', key: 'ENG', name: 'Engineering' },
        { id: '10002', key: 'PLAT', name: 'Platform' },
      ],
      jiraIssueTypes: [{ id: '10100', name: 'Task' }],
      // In flight and never settling — the state the project change cancels.
      hang: ['/jira/compose-meta'],
    })
    await render()
    expect(container.textContent).toContain('create screen')

    // Switching project nulls the issue type — the meta effect re-runs and
    // early-returns without starting a fetch.
    await pickProject('Platform')

    expect(container.textContent).not.toContain('create screen')
  })

  /**
   * REGRESSION (review finding: "Retry button cannot recover a failed child-slot
   * load; failure banner hides the form so the panel bricks until
   * close/reopen").
   *
   * A slot failure replaces the ENTIRE field form with the banner, so the user
   * cannot even change the parent field to force a reload — Retry is the only
   * affordance left. It bumped `retryKey`, but `retryKey` was a dependency of
   * only the config and compose-meta effects; every CHILD slot keyed off derived
   * strings that a retry does not change, so the failed slot was never
   * re-requested and its failure was never cleared. The banner re-rendered
   * identically, forever, for a failure on an OPTIONAL field.
   */
  it('Retry re-runs a failed CHILD slot and clears the banner', async () => {
    const { heal } = installFetch({
      config: { team_id: 'team-1' },
      linearTeams: [{ id: 'team-1', key: 'ENG', name: 'Engineering' }],
      linearMembers: [
        { id: 'u-1', name: 'ada', full_name: 'Ada', email: null, avatar_url: null },
      ],
      // Members is a CHILD of the team — the slot whose effect keys on
      // linearTeamId, which a Retry does not change.
      failUntilHealed: {
        '/linear/members': { status: 500, body: { error: 'Linear is down' } },
      },
    })
    await render({ provider: 'linear', providerName: 'Linear' })

    // The whole form is gone, replaced by the banner.
    expect(container.textContent).toContain('Linear is down')

    // The backend recovers; only a genuine re-request can discover that.
    heal()
    const before = calls.filter((u) => u.includes('/linear/members')).length
    await act(async () => {
      buttonByText('Retry')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The child slot was actually re-requested…
    expect(calls.filter((u) => u.includes('/linear/members')).length).toBeGreaterThan(before)
    // …and the banner is gone, so the user has their form back.
    expect(container.textContent).not.toContain('Linear is down')
    expect(createButton()).toBeTruthy()
  })
})

/**
 * REGRESSION (review finding: "Clearing the project search query never restores
 * the browse list").
 *
 * The typed search REPLACES the slot's options wholesale (Jira matches on key as
 * well as name, so a client-side filter would miss "ENG"). Its effect
 * early-returned on an empty query and the browse effect never re-ran — its deps
 * are all unchanged — so deleting the search text left the last search's results
 * as the ONLY options for the rest of the panel's life. The user sees an empty
 * search box next to a list their configured project has vanished from, and
 * concludes their projects are missing. The settings picker this deviates from
 * re-runs its fetch on every query change including empty, which is why it never
 * had this bug.
 */
describe('PushComposePanel — clearing the project search', () => {
  /**
   * RE-TARGETED (the inline-compose rework): reads the OPTION LIST rather than
   * the whole container.
   *
   * In the dialog the `SearchableOptionList` was rendered inline, so every
   * project name was in `container.textContent`. In the strip it lives behind a
   * field-shaped trigger (a 200px list box cannot sit in a one-line strip), and
   * the trigger itself shows the SELECTED project's name — so a whole-container
   * read would now conflate "Engineering is in the list" with "Engineering is
   * the current pick". Scoping to the open list keeps the assertion about the
   * thing the fix was about: the browse list is re-issued rather than left as
   * the last search's leftovers. The claim is unchanged.
   */
  it('restores the full browse list when the query is emptied', async () => {
    installFetch({
      config: { cloud_id: 'cloud-1' },
      jiraProjects: [
        { id: '10001', key: 'ENG', name: 'Engineering' },
        { id: '10002', key: 'DES', name: 'Design' },
      ],
    })
    await render()
    await openProjectPicker()
    expect(projectOptionNames()).toContain('Engineering')
    expect(projectOptionNames()).toContain('Design')

    await typeSearch('Design')
    // The search really did replace the list — Engineering is gone.
    expect(projectOptionNames()).not.toContain('Engineering')

    await typeSearch('')

    // Both are back — the browse list was re-issued rather than left as the
    // last search's leftovers.
    expect(projectOptionNames()).toContain('Engineering')
    expect(projectOptionNames()).toContain('Design')
  })

  it('does not re-fetch the browse list on the panel’s first open', async () => {
    // The restore is guarded by "a search actually replaced this slot", so an
    // untouched panel still issues exactly one projects request.
    installFetch({
      config: { cloud_id: 'cloud-1' },
      jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
    })
    await render()
    expect(calls.filter((u) => u.includes('/jira/projects')).length).toBe(1)
  })
})

/**
 * REGRESSION (review finding: "Editing the title can be silently overwritten
 * while the panel is open when defaultTitle changes").
 *
 * The seeding effect ran on every `defaultTitle` change, not just on open —
 * directly contradicting its own comment ("a re-render must never type over what
 * they wrote"). The prop is genuinely live: the detail panel feeds `action.title`
 * from state patched by the entity bus (inline row edits, bulk actions, AI
 * tools, realtime), so a teammate renaming the action mid-composition replaced
 * the user's typed summary.
 */
/**
 * RE-TARGETED WHOLESALE — this section defended a field that no longer exists.
 *
 * Both tests protected the strip's own title input: one that a live rename
 * could not type over what the user had written mid-compose, one that the field
 * seeded from `defaultTitle` on open. The strip stopped offering a title (the
 * card renders it; compose swaps only the property row beneath), so there is no
 * second copy of the title to seed or to clobber — the hazard is gone by
 * construction rather than defended against.
 *
 * What survives is the half that still has teeth: a live rename must not
 * disturb the form's OTHER state. That is the same underlying risk — a
 * re-render from a changed prop reaching into the user's in-progress work —
 * expressed against the fields compose still owns.
 */
describe('PushComposePanel — a live rename does not disturb the form', () => {
  it('keeps the user’s picks when defaultTitle changes mid-compose', async () => {
    installFetch({
      config: { cloud_id: 'cloud-1', project_id: '10001', project_key: 'ENG', issue_type_id: '10100' },
      jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
      jiraIssueTypes: [
        { id: '10100', name: 'Task' },
        { id: '10101', name: 'Bug' },
      ],
    })
    await render()
    await setSelect('Issue type', '10101')

    // A teammate renames the action; the prop changes underneath the live form.
    await render({ defaultTitle: 'Renamed by someone else' })

    expect(selectByLabel('Issue type')!.value).toBe('10101')
  })

  it('takes the NEW title as the thing being pushed, since it holds no copy', async () => {
    // The counterpart of the above: with no title field, a rename is simply the
    // truth about what is being pushed — nothing to reconcile.
    installFetch({ config: { cloud_id: 'cloud-1' } })
    await render({ defaultTitle: 'Renamed by someone else' })
    expect(inputByLabel('Title')).toBeUndefined()
  })
})

// ---- creating ---------------------------------------------------------------

describe('PushComposePanel — Create', () => {
  const BASE = {
    config: { cloud_id: 'cloud-1', project_id: '10001', project_key: 'ENG', issue_type_id: '10100' },
    jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
    jiraIssueTypes: [{ id: '10100', name: 'Task' }],
  }

  /**
   * RE-TARGETED (was: "closes on success", asserting `onOpenChange(false)`).
   *
   * Leaving compose mode on success is now the CALLER's job — it is the thing
   * that also closes the menu and republishes the links, and a form that ALSO
   * called `onCancel` would fire the transition twice, which every
   * `onComposeChange` listener (the row hiding its chips, the board routing to
   * the panel) would see as a second, spurious end. So the claim moves from
   * "the form closes itself" to "the form reports the outcome and does not
   * self-cancel"; that the caller then ends compose is pinned in the menu suite.
   */
  it('reports success WITHOUT cancelling itself — the caller owns the exit', async () => {
    installFetch(BASE)
    const onCancel = vi.fn()
    const onCreate = vi.fn(async () => true)
    await render({ onCancel, onCreate })
    await clickCreate()
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  /**
   * RE-TARGETED (was: "STAYS OPEN …", asserting `onOpenChange` was not called
   * with false). Same claim, expressed against `onCancel`: the form must not
   * tear itself down on a failure the user can fix in place.
   */
  it('STAYS UP with every choice intact when the push fails', async () => {
    // The fixable failures (a rejected field, a project that refused the type)
    // are fixed in this very strip — tearing it down would make the user rebuild
    // the form to change one field.
    //
    // RE-TARGETED: "every choice intact" was demonstrated with the title input,
    // which is gone. The claim needs a field the strip still owns, so it is
    // shown against the Labels chip — same assertion, surviving control.
    installFetch({ ...BASE, jiraMeta: fullMeta() })
    const onCancel = vi.fn()
    await render({ onCancel, onCreate: async () => false })
    await setInput('Labels', 'backend, q3')
    await clickCreate()
    expect(onCancel).not.toHaveBeenCalled()
    expect(inputByLabel('Labels')!.value).toBe('backend, q3')
  })

  /**
   * RE-TARGETED: the empty title now comes from the ACTION, not from a field.
   *
   * The strip has no title box to type spaces into, so the untitled case is a
   * `defaultTitle` that is blank — an action nobody named. Create must still
   * refuse it (every provider rejects an untitled issue), and the sentence now
   * points at the card, which is the only place the title can be fixed.
   */
  it('refuses an untitled ACTION rather than pushing an untitled issue', async () => {
    installFetch(BASE)
    const onCreate = await render({ defaultTitle: '   ' })
    expect(createButton().disabled).toBe(true)
    expect(container.textContent).toContain('needs a title')
    await clickCreate()
    expect(onCreate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// THE STRIP — the rework's own claims
// ---------------------------------------------------------------------------

/**
 * NEW (the inline-compose rework). Everything above pins WHAT compose sends;
 * this section pins WHERE it now lives, which is the thing Liam actually asked
 * to change: "I don't want it to be a pop-up… just make it so that it scrolls
 * horizontally. That way if there's more fields than you can fit on the screen,
 * you can just scroll left and right." Plus a Create at the far right end.
 */
describe('PushComposePanel — the horizontal strip', () => {
  const BASE = {
    config: { cloud_id: 'cloud-1', project_id: '10001', project_key: 'ENG', issue_type_id: '10100' },
    jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
    jiraIssueTypes: [{ id: '10100', name: 'Task' }],
  }

  function scroller(): HTMLElement {
    return container.querySelector('[data-compose-scroller]') as HTMLElement
  }

  it('IS NOT A DIALOG — the fields render straight into the surface', async () => {
    // The whole rework in one assertion. A Dialog would portal itself to the
    // body behind an overlay; the strip is a plain child of whatever mounted it.
    installFetch(BASE)
    await render()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('[data-compose-surface="strip"]')).toBeTruthy()
    // …and it really did render the form, so this isn't passing by rendering
    // nothing at all. (Was the Title input, which the strip no longer offers;
    // the project chip is the field every provider's strip always has.)
    expect(container.querySelector('[data-compose-project-trigger]')).toBeTruthy()
  })

  it('puts every field in ONE horizontally scrollable container', async () => {
    installFetch({ ...BASE, jiraMeta: fullMeta() })
    await render()
    const box = scroller()
    expect(box).toBeTruthy()
    // The two that matter together: x scrolls, y does NOT. A lone
    // `overflow-x-auto` computes `overflow-y: auto`, which would make the strip
    // a vertical scroll container too and let a trackpad flick inside it
    // swallow the page's own scroll.
    expect(box.className).toContain('overflow-x-auto')
    expect(box.className).toContain('overflow-y-hidden')
  })

  /**
   * THE PROJECT POPOVER MUST ESCAPE THE SCROLLER.
   *
   * WHAT JSDOM CANNOT SEE, stated plainly because it is the reason these tests
   * are shaped the way they are: jsdom has no layout engine. `overflow` clips
   * nothing here, every box measures 0x0, and `getBoundingClientRect` returns
   * zeroes — so the actual defect (the popover cropped to a sliver by the
   * strip's `overflow-x-auto`/`overflow-y-hidden`, verified in a real browser)
   * is INVISIBLE to this environment. A test that opened the picker and found
   * its options passed both before and after the fix.
   *
   * What jsdom CAN pin is the structural property that causes the clipping:
   * whether the popover is a DOM DESCENDANT of the scroller. A CSS `overflow`
   * clips its own descendants and nothing else, so "not inside the scroller" is
   * exactly equivalent to "not clipped by it" — and that survives as a
   * regression guard even though the pixels do not.
   */
  it('renders the project popover OUTSIDE the scroller, so overflow cannot clip it', async () => {
    installFetch(BASE)
    await render()
    await openProjectPicker()

    const list = searchInput()
    expect(list).toBeTruthy()

    // THE ASSERTION. An absolutely-positioned child of the scroller — what this
    // was before — would be a descendant and would be clipped to a sliver.
    const box = scroller()
    expect(box).toBeTruthy()
    expect(box.contains(list)).toBe(false)
  })

  it('portals the popover clear of the render container entirely', async () => {
    // Radix portals to the body. Pinning that explicitly means a later "tidy-up"
    // that swaps the Popover back for a plain absolute div fails here rather
    // than silently restoring the invisible-picker bug.
    installFetch(BASE)
    await render()
    await openProjectPicker()

    const popover = document.querySelector('[data-compose-project-popover]')
    expect(popover).toBeTruthy()
    expect(container.contains(popover)).toBe(false)
    // The trigger, by contrast, stays in the strip where the user clicked it.
    expect(container.querySelector('[data-compose-project-trigger]')).toBeTruthy()
  })

  it('still picks a project through the portalled list', async () => {
    // Escaping the scroller must not cost the field its function: the portalled
    // options are still live and selecting one still lands on the trigger.
    installFetch(BASE)
    await render()
    await pickProject('Engineering')

    const trigger = container.querySelector('[data-compose-project-trigger]') as HTMLElement
    expect(trigger.textContent).toContain('Engineering')
  })

  it('does NOT leak the popover click to the row underneath', async () => {
    // Radix portals through the REACT tree, so events from the portalled content
    // still bubble to the strip's wrapper and hit its suppression. If they did
    // not, choosing a project would also open the action's detail panel.
    const onRowClick = vi.fn()
    const onRowPointerDown = vi.fn()
    installFetch(BASE)
    await renderInRow({}, { onClick: onRowClick, onPointerDown: onRowPointerDown })
    await pickProject('Engineering')

    expect(onRowClick).not.toHaveBeenCalled()
    expect(onRowPointerDown).not.toHaveBeenCalled()
  })

  it('dismisses the popover on an outside click', async () => {
    // The old hand-rolled panel had no outside-click handling at all: it stayed
    // open until the trigger was pressed again.
    installFetch(BASE)
    await render()
    await openProjectPicker()
    expect(searchInput()).toBeTruthy()

    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(searchInput()).toBeNull()
  })

  it('OVERFLOWS rather than wrapping when the issue type has many fields', async () => {
    // The case the strip exists for. Six required customs on top of the four
    // natives is a real Jira create screen and was unusable in a fixed dialog.
    installFetch({
      ...BASE,
      jiraMeta: fullMeta({
        custom_fields: Array.from({ length: 6 }, (_, i) => ({
          field_id: `customfield_1000${i}`,
          name: `Custom ${i}`,
          required: false,
          options: [{ id: `opt-${i}`, name: `Option ${i}` }],
        })),
      }),
    })
    await render()

    // Every field is PRESENT — nothing was dropped to make it fit…
    const fields = scroller().querySelectorAll('[data-compose-field]')
    expect(fields.length).toBeGreaterThanOrEqual(10)
    for (let i = 0; i < 6; i += 1) {
      expect(selectByLabel(`Custom ${i}`)).toBeTruthy()
    }
    // …and each one holds its width rather than shrinking, which is what turns
    // "more fields" into "more scroll" instead of "narrower fields".
    for (const field of Array.from(fields)) {
      expect(field.className).toContain('shrink-0')
    }
  })

  it('pins Create at the FAR RIGHT, outside the scroller', async () => {
    // A Create that scrolled away with the fields would be a button the user has
    // to go looking for.
    installFetch(BASE)
    await render()
    const actions = container.querySelector('[data-compose-actions]') as HTMLElement
    expect(actions).toBeTruthy()
    expect(actions.contains(createButton())).toBe(true)
    // Not inside the scrolling half.
    expect(scroller().contains(createButton())).toBe(false)
    // And it is the LAST thing on the line (the cancel X sits beside it).
    const strip = container.querySelector('[data-compose-surface="strip"]') as HTMLElement
    expect(strip.lastElementChild).toBe(actions)
  })

  it('offers an X that leaves compose mode', async () => {
    installFetch(BASE)
    const onCancel = vi.fn()
    await render({ onCancel })
    const x = container.querySelector('[aria-label="Cancel push to Jira"]') as HTMLButtonElement
    expect(x).toBeTruthy()
    await act(async () => {
      x.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('ESCAPE leaves compose mode', async () => {
    // The Dialog gave this for free; a strip inside a row has to say it.
    installFetch(BASE)
    const onCancel = vi.fn()
    await render({ onCancel })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Escape does NOT abandon a push already in flight', async () => {
    // The row is about to change underneath; tearing the form down mid-request
    // would drop the only UI that can report the result.
    installFetch(BASE)
    const onCancel = vi.fn()
    // A push that never settles — the window Escape must not act in.
    await render({ onCancel, onCreate: () => new Promise<boolean>(() => {}) })
    await clickCreate()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('stops a click inside the strip from opening the row underneath', async () => {
    // Every surface this mounts in has a gesture of its own: the list row opens
    // the detail panel on click. Picking a project must not also navigate.
    // The wrapper is a REACT element because React 19 delegates to the root — a
    // native listener there would fire before any component handler and "pass"
    // whatever the strip does.
    // (Driven from the project chip rather than the removed Title input — any
    // control inside the strip exercises the wrapper's guard identically.)
    installFetch(BASE)
    const rowClick = vi.fn()
    await renderInRow({}, { onClick: rowClick })
    await act(async () => {
      container
        .querySelector('[data-compose-project-trigger]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('stops a POINTER-DOWN inside the strip from arming the board card’s drag', async () => {
    // The half a click-only guard would miss: dnd-kit arms on pointer-down, so
    // dragging a date field would drag the card.
    // (Driven from the project chip rather than the removed Title input.)
    installFetch(BASE)
    const cardPointerDown = vi.fn()
    await renderInRow({}, { onPointerDown: cardPointerDown })
    await act(async () => {
      container
        .querySelector('[data-compose-project-trigger]')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(cardPointerDown).not.toHaveBeenCalled()
  })

  it('leaves the row’s own gestures alone OUTSIDE the strip (the guard is scoped)', async () => {
    // The counterpart to the two above: a strip that stopped everything on the
    // row would pass them and break the row.
    installFetch(BASE)
    const rowClick = vi.fn()
    await renderInRow({}, { onClick: rowClick })
    await act(async () => {
      container.querySelector('[data-row-body]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(rowClick).toHaveBeenCalledTimes(1)
  })

  it('keeps the failure banner INSIDE the strip rather than growing the row', async () => {
    // A row whose height jumps when a token dies would shove every row below it.
    installFetch({
      config: { cloud_id: 'cloud-1' },
      fail: {
        '/jira/projects': { status: 400, body: { error: 'x', code: 'reconnect_required' } },
      },
    })
    await render()
    const banner = container.querySelector('[data-compose-failure="reconnect"]') as HTMLElement
    expect(banner).toBeTruthy()
    expect(scroller().contains(banner)).toBe(true)
    // Compact wording, and still the way out.
    expect(banner.textContent).toContain('Reconnect Jira to compose')
    expect(buttonByText('Open Jira settings')).toBeTruthy()
  })
})

/**
 * NEW (the inline-compose rework). The detail panel's properties sidebar is
 * already a narrow vertical column, so the same form stacks there instead of
 * scrolling. The point of this section is that it is the SAME form: only the box
 * differs, so no gating, no override and no wall is re-implemented.
 */
describe('PushComposePanel — the sidebar (stack) variant', () => {
  const BASE = {
    config: { cloud_id: 'cloud-1', project_id: '10001', project_key: 'ENG', issue_type_id: '10100' },
    jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
    jiraIssueTypes: [{ id: '10100', name: 'Task' }],
  }

  it('renders as a stack with NO horizontal scroller', async () => {
    installFetch({ ...BASE, jiraMeta: fullMeta() })
    await render({ layout: 'stack' })
    expect(container.querySelector('[data-compose-surface="stack"]')).toBeTruthy()
    expect(container.querySelector('[data-compose-scroller]')).toBeNull()
  })

  it('renders the very same fields, gated the very same way', async () => {
    installFetch({ ...BASE, jiraMeta: fullMeta({ has_due_date: false }) })
    await render({ layout: 'stack' })
    expect(selectByLabel('Assignee')).toBeTruthy()
    expect(selectByLabel('Priority')).toBeTruthy()
    expect(inputByLabel('Labels')).toBeTruthy()
    // The create-screen gate is the form's, not the strip's.
    expect(inputByLabel('Due date')).toBeUndefined()
  })

  it('builds the same override body', async () => {
    installFetch({
      ...BASE,
      jiraMeta: fullMeta(),
      jiraUsers: [
        { account_id: 'acc-1', display_name: 'Ada Lovelace', email: 'ada@acme.com', active: true },
      ],
    })
    const onCreate = await render({ layout: 'stack' })
    await setSelect('Assignee', 'acc-1')
    await setInput('Due date', '2026-09-01')
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({
      assignee_account_id: 'acc-1',
      due_date: '2026-09-01',
    })
  })

  it('an untouched sidebar form still sends {}', async () => {
    installFetch(BASE)
    const onCreate = await render({ layout: 'stack' })
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({})
  })

  it('keeps Escape and a named Cancel', async () => {
    installFetch(BASE)
    const onCancel = vi.fn()
    await render({ layout: 'stack', onCancel })
    // In the sidebar there is room for a word rather than an X.
    const cancel = container.querySelector('[aria-label="Cancel push to Jira"]') as HTMLButtonElement
    expect(cancel.textContent).toContain('Cancel')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows the FULL blocking-field explanation the sidebar has room for', async () => {
    installFetch({
      ...BASE,
      jiraNativeUrl: 'https://acme.atlassian.net/secure/CreateIssue.jspa',
      jiraMeta: fullMeta({
        blocking_fields: [{ field_id: 'customfield_10099', name: 'Sprint', schema_type: 'array' }],
      }),
    })
    await render({ layout: 'stack' })
    const wall = container.querySelector('[data-jira-blocking-wall]') as HTMLElement
    expect(wall.textContent).toContain('Sprint')
    expect(wall.textContent).toContain('no values Dial8 can choose from')
    expect(createButton().disabled).toBe(true)
  })
})

/**
 * NEW (the inline-compose rework): the un-pinned clear legs and the
 * disable-while-loading guards, carried forward from the re-audit.
 *
 * Every one of these is a behaviour the fix round SHIPPED but nothing asserted —
 * so a refactor (this one, or the next) could have silently dropped it. They are
 * pinned here, in the world the strip lives in.
 */
describe('PushComposePanel — cleared fields that had no test', () => {
  it('jira: an assignee explicitly set to Unassigned travels as null', async () => {
    // Absent means "fall back to the action's own assignee"; null means the user
    // looked at the field and chose nobody. The push reads them oppositely.
    installFetch({
      config: { cloud_id: 'cloud-1', project_id: '10001', project_key: 'ENG', issue_type_id: '10100' },
      jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
      jiraIssueTypes: [{ id: '10100', name: 'Task' }],
      jiraMeta: fullMeta(),
      jiraUsers: [
        { account_id: 'acc-1', display_name: 'Ada Lovelace', email: null, active: true },
      ],
    })
    const onCreate = await render()
    await setSelect('Assignee', '__none__')
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({ assignee_account_id: null })
  })

  it('jira: an untouched assignee is OMITTED, not nulled', async () => {
    // The other half — without it the test above would pass on a form that
    // nulled everything and broke every inherit.
    installFetch({
      config: { cloud_id: 'cloud-1', project_id: '10001', project_key: 'ENG', issue_type_id: '10100' },
      jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
      jiraIssueTypes: [{ id: '10100', name: 'Task' }],
      jiraMeta: fullMeta(),
    })
    const onCreate = await render()
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({})
  })

  it('jira: a cleared due date travels as null', async () => {
    installFetch({
      config: { cloud_id: 'cloud-1', project_id: '10001', project_key: 'ENG', issue_type_id: '10100' },
      jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
      jiraIssueTypes: [{ id: '10100', name: 'Task' }],
      jiraMeta: fullMeta(),
    })
    const onCreate = await render()
    // RE-TARGETED: set through the calendar, cleared through the chip's X.
    // `DateTimePicker` cannot emit "no date", so clearing moved to an explicit
    // control beside it rather than being lost — the null this asserts is the
    // whole reason that control exists.
    await pickDate('Due date', '2026-09-01')
    await clearDate('Due date')
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({ due_date: null })
  })

  const ASANA_BASE = {
    config: { asana_workspace_gid: 'ws-gid', project_gid: 'proj-1' },
    asanaProjects: [{ gid: 'proj-1', name: 'Engineering' }],
    asanaSections: [{ gid: 'sec-1', name: 'In progress' }],
    asanaUsers: [{ gid: 'user-1', name: 'Ada', email: null }],
  }

  it('asana: "No section" travels as an explicit null KEY', async () => {
    // asana-push reads `'section_gid' in overrides`, not truthiness — key
    // PRESENCE is what suppresses the workspace's section_map. A form that
    // omitted the key would silently reinstate the mapping the user just
    // cleared.
    installFetch(ASANA_BASE)
    const onCreate = await render({ provider: 'asana', providerName: 'Asana' })
    await setSelect('Section', 'sec-1')
    await setSelect('Section', '__none__')
    await clickCreate()
    const overrides = (onCreate as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect('section_gid' in overrides).toBe(true)
    expect(overrides.section_gid).toBeNull()
  })

  it('asana: a cleared assignee travels as an explicit null KEY', async () => {
    installFetch(ASANA_BASE)
    const onCreate = await render({ provider: 'asana', providerName: 'Asana' })
    await setSelect('Assignee', 'user-1')
    await setSelect('Assignee', '__none__')
    await clickCreate()
    const overrides = (onCreate as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect('assignee_gid' in overrides).toBe(true)
    expect(overrides.assignee_gid).toBeNull()
  })

  it('asana: a cleared due date travels as an explicit null KEY', async () => {
    installFetch(ASANA_BASE)
    const onCreate = await render({ provider: 'asana', providerName: 'Asana' })
    // RE-TARGETED to the calendar + the chip's clear button; see the Jira twin.
    await pickDate('Due date', '2026-09-01')
    await clearDate('Due date')
    await clickCreate()
    const overrides = (onCreate as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect('due_on' in overrides).toBe(true)
    expect(overrides.due_on).toBeNull()
  })

  it('asana: an UNTOUCHED form sends no clear keys at all', async () => {
    installFetch(ASANA_BASE)
    const onCreate = await render({ provider: 'asana', providerName: 'Asana' })
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({})
  })
})

describe('PushComposePanel — dependent fields are unpickable while loading', () => {
  /**
   * The slot deliberately KEEPS the previous parent's options during the flight
   * so the field doesn't flash empty — which means what is listed mid-load
   * belongs to the parent the user just navigated away from, and a pick made
   * there is an id the new parent has never heard of.
   */
  it('jira: the issue type is disabled while its list is in flight', async () => {
    installFetch({
      config: { cloud_id: 'cloud-1' },
      jiraProjects: [{ id: '10001', key: 'ENG', name: 'Engineering' }],
      hang: ['/jira/issue-types'],
    })
    await render()
    await pickProject('Engineering')
    expect(selectByLabel('Issue type')!.disabled).toBe(true)
  })

  it('jira: the issue type is disabled before any project is chosen', async () => {
    installFetch({ config: { cloud_id: 'cloud-1' }, jiraProjects: [] })
    await render()
    expect(selectByLabel('Issue type')!.disabled).toBe(true)
  })

  it('asana: the section is disabled while the new project’s sections load', async () => {
    installFetch({
      config: { asana_workspace_gid: 'ws-gid' },
      asanaProjects: [{ gid: 'proj-1', name: 'Engineering' }],
      hang: ['/asana/sections'],
    })
    await render({ provider: 'asana', providerName: 'Asana' })
    await pickProject('Engineering')
    expect(selectByLabel('Section')!.disabled).toBe(true)
  })

  it('linear: project and assignee are disabled while the new team’s lists load', async () => {
    installFetch({
      config: { team_id: 'team-1' },
      linearTeams: [
        { id: 'team-1', key: 'ENG', name: 'Engineering' },
        { id: 'team-2', key: 'DES', name: 'Design' },
      ],
      hang: ['/linear/projects', '/linear/members'],
    })
    await render({ provider: 'linear', providerName: 'Linear' })
    expect(selectByLabel('Project')!.disabled).toBe(true)
    expect(selectByLabel('Assignee')!.disabled).toBe(true)
  })

  it('linear: both are disabled before a team is chosen', async () => {
    installFetch({ config: {}, linearTeams: [{ id: 'team-1', key: null, name: 'Engineering' }] })
    await render({ provider: 'linear', providerName: 'Linear' })
    expect(selectByLabel('Project')!.disabled).toBe(true)
    expect(selectByLabel('Assignee')!.disabled).toBe(true)
  })
})

// ---- the chip idiom --------------------------------------------------------

/**
 * THE STRIP IS A ROW OF PROPERTY CHIPS, not a form.
 *
 * Liam's spec was always "the SAME property presentation the action already
 * has, populated with the provider's options" — Dial8 renders an action's
 * properties as compact outline pills (`PropertyPill` in proposal-card.tsx /
 * create-dialog.tsx / attention-card.tsx, `chipClass`/`cellTriggerClass` in
 * lib/views/property-options.ts), and the compose strip rendered a form
 * instead: uppercase captions above boxed inputs of three different heights,
 * with a ragged bottom edge.
 *
 * What these pin is the part a screenshot would catch and the suites above
 * would not: every control is one chip, all chips are the same height, the
 * placeholder carries the field's NAME while a selection carries its VALUE, and
 * a chip still opens the picker it always did. The behavioural suites above are
 * untouched and remain the contract for what the form SENDS.
 */
describe('PushComposePanel — the strip renders properties as chips', () => {
  const JIRA_FULL = {
    config: { cloud_id: 'cloud-1', project_id: 'proj-1', project_key: 'ENG', issue_type_id: 'it-1' },
    jiraProjects: [{ id: 'proj-1', key: 'ENG', name: 'Engineering' }],
    jiraIssueTypes: [{ id: 'it-1', name: 'Task' }],
    jiraUsers: [
      { account_id: 'acc-1', display_name: 'Ada', email: 'ada@x.com', active: true },
    ],
    jiraMeta: {
      has_assignee: true,
      has_priority: true,
      has_due_date: true,
      has_labels: true,
      priorities: [{ id: 'p-1', name: 'High' }],
      custom_fields: [],
      blocking_fields: [],
    },
  }

  /**
   * The chip element of every field in the strip.
   *
   * Read by its h-7 token rather than by position, because the fields nest
   * differently on purpose: a Select-backed chip IS the trigger, while the
   * free-text ones (Title, Labels) and the date input sit inside a `relative`
   * wrapper that positions their leading icon. The chip is the styled element
   * in either case.
   */
  function chips(): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-compose-scroller] [data-compose-field] [class*="h-7"]',
      ),
    )
  }

  it('EVERY field is a chip on ONE uniform line — no captions, no staircase', async () => {
    installFetch(JIRA_FULL)
    await render({ provider: 'jira', providerName: 'Jira' })

    // The uppercase field captions the form used are GONE — that vocabulary
    // ("TITLE", "ASSIGNEE", "DUE DATE" stacked above boxes) is the form
    // aesthetic this replaced.
    const captions = Array.from(
      container.querySelectorAll('[data-compose-scroller] p'),
    ).filter((p) => p.className.includes('uppercase'))
    expect(captions).toHaveLength(0)

    // Uniform height is what removes the ragged bottom edge. h-7 is the token
    // PropertyPill and the proposal card's due-date pill both use.
    const fields = Array.from(container.querySelectorAll('[data-compose-field]'))
    expect(fields.length).toBeGreaterThan(3)
    for (const field of fields) {
      const control = field.querySelector('.h-7, [class*="h-7"]')
      expect(control, `${field.getAttribute('data-compose-field')} is not chip-height`).toBeTruthy()
    }

    // Rounded-full is the other half of the pill idiom — a rounded-md box is
    // what the form looked like.
    for (const chip of chips()) {
      expect(chip.className).toContain('rounded-full')
    }
  })

  it('the scroller centres one line rather than bottom-aligning columns', async () => {
    // `items-end` was the old strip's only way to make columns of different
    // heights agree at their bottom edge. Uniform chips sit on one line, and
    // centring them is what finishes the alignment.
    installFetch(JIRA_FULL)
    await render({ provider: 'jira', providerName: 'Jira' })
    const scroller = container.querySelector('[data-compose-scroller]')!
    expect(scroller.className).toContain('items-center')
    expect(scroller.className).not.toContain('items-end')
    // The line still scrolls sideways — that contract is untouched.
    expect(scroller.className).toContain('overflow-x-auto')
  })

  it('an unset chip shows the field NAME; a set one shows its VALUE', async () => {
    // This is the whole reason the captions could go: a native property pill
    // reads "Project" when empty and "Engineering" when filled, so the label
    // and the value never need to be on screen at once.
    installFetch(JIRA_FULL)
    await render({ provider: 'jira', providerName: 'Jira' })

    // Prefilled from the config — the chip carries the project's real name,
    // exactly as the boxed control did.
    const project = container.querySelector('[data-compose-project-trigger]')!
    expect(project.textContent).toContain('Engineering')

    // Untouched optional field — the chip names itself.
    const labels = inputByLabel('Labels')!
    expect(labels.value).toBe('')
    expect(labels.getAttribute('placeholder')).toBe('Labels')
  })

  it('a required chip that is still unanswered goes destructive', async () => {
    // PropertyPill's own `error` state, in the strip: the wall is shown on the
    // chip that causes it rather than only in the sentence beside Create.
    installFetch({
      ...JIRA_FULL,
      config: { cloud_id: 'cloud-1' },
      jiraMeta: { ...JIRA_FULL.jiraMeta, assignee_required: true },
    })
    await render({ provider: 'jira', providerName: 'Jira' })
    const project = container.querySelector('[data-compose-project-trigger]')!
    expect(project.className).toContain('destructive')
  })

  it('clicking the project chip still opens the picker it always did', async () => {
    installFetch(JIRA_FULL)
    await render({ provider: 'jira', providerName: 'Jira' })
    expect(searchInput()).toBeFalsy()
    await openProjectPicker()
    // The same SearchableOptionList, with the same search box.
    expect(searchInput()).toBeTruthy()
    expect(projectOptionNames()).toContain('Engineering')
  })

  it('the Linear labels chip summarises the picks and opens the toggles', async () => {
    installFetch({
      config: { team_id: 'team-1' },
      linearTeams: [{ id: 'team-1', key: 'ENG', name: 'Engineering' }],
      linearLabels: [
        { id: 'lab-1', name: 'Bug', color: '#f00', scope: 'team' },
        { id: 'lab-2', name: 'Chore', color: null, scope: 'team' },
      ],
    })
    const onCreate = await render({ provider: 'linear', providerName: 'Linear' })

    // Closed and empty, the chip is named for its field.
    const trigger = () => container.querySelector('[data-compose-labels-trigger]')!
    expect(trigger().textContent).toContain('Labels')

    // One pick names itself rather than becoming a count.
    const toggles = await labelToggles()
    const bug = Array.from(toggles.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Bug'),
    )!
    await act(async () => {
      bug.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(trigger().textContent).toContain('Bug')

    // And the value it collects is unchanged.
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({ label_ids: ['lab-1'] })
  })

  it('STACK KEEPS ITS LABELS — a sidebar column reads correctly with captions', async () => {
    // The chip row is the ROW's idiom. The detail panel's properties sidebar is
    // a narrow vertical column where a named row is already the native
    // presentation, so it is deliberately left alone — and its hints stay
    // visible text rather than moving to a `title`.
    installFetch({
      config: { asana_workspace_gid: 'ws-gid', project_gid: 'proj-1' },
      asanaProjects: [{ gid: 'proj-1', name: 'Engineering' }],
      asanaSections: [{ gid: 'sec-1', name: 'Todo' }],
    })
    await render({ provider: 'asana', providerName: 'Asana', layout: 'stack' })
    expect(container.querySelector('[data-compose-surface="stack"]')).toBeTruthy()
    expect(container.textContent).toContain('Due date')
    expect(container.textContent).toContain('Asana due dates are date-only.')
  })
})

// ---------------------------------------------------------------------------
// THE DATE CHIP — Dial8's own picker, and the wire format it must not move
// ---------------------------------------------------------------------------

/**
 * NEW. The strip's date field was an `<input type="date">` — the one control in
 * the row that was the BROWSER's rather than the app's, rendering a native
 * widget with a calendar glyph no other chip had. It is now the same
 * `DateTimePicker` the proposal card's due-date pill wraps.
 *
 * The predecessor kept the native input for a real reason: routing a calendar
 * date through a `Date` risks a timezone slip on the one field where that
 * silently moves a deadline by a day. That hazard is SOLVED rather than
 * inherited, and this section is what holds the solution in place — because a
 * regression here is invisible in review (`toISOString()` looks perfectly
 * reasonable) and shows up as a deadline off by one for users west of UTC.
 *
 * The conversion is local-parts-only in BOTH directions:
 *   reading  `new Date('2026-03-14')` would parse as UTC MIDNIGHT → the 13th in
 *            any negative-offset zone. So the string is split and fed to the
 *            local `Date(y, m, d)` constructor.
 *   writing  `toISOString()` converts to UTC first → local midnight in New York
 *            serialises as the previous day at 05:00Z. So the parts are read
 *            with the LOCAL getters and assembled as a string.
 */
describe('PushComposePanel — the date chip preserves the wire format', () => {
  const JIRA_DATE = {
    config: { cloud_id: 'cloud-1', project_id: 'proj-1', project_key: 'ENG', issue_type_id: 'it-1' },
    jiraProjects: [{ id: 'proj-1', key: 'ENG', name: 'Engineering' }],
    jiraIssueTypes: [{ id: 'it-1', name: 'Task' }],
    jiraMeta: {
      has_assignee: false,
      has_priority: false,
      has_due_date: true,
      has_labels: false,
      priorities: [],
      custom_fields: [],
      blocking_fields: [],
    },
  }

  it('IS DIAL8’S PICKER, not the browser’s date input', async () => {
    installFetch(JIRA_DATE)
    await render({ provider: 'jira', providerName: 'Jira' })

    // The native control is gone from the strip…
    expect(container.querySelector('[data-compose-scroller] input[type="date"]')).toBeNull()
    // …replaced by a chip that opens the app's own calendar.
    const chip = dateChip('Due date')!
    expect(chip).toBeTruthy()
    expect(chip.className).toContain('rounded-full')
    expect(chip.className).toContain('h-7')

    expect(document.querySelector('[role="grid"]')).toBeFalsy()
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.querySelector('[role="grid"]')).toBeTruthy()
  })

  /**
   * THE REGRESSION TEST FOR THE TIMEZONE SLIP.
   *
   * Every date here is chosen to break under a UTC round trip in this suite's
   * own timezone, and the dates nearest the boundaries are the ones that catch
   * it: Jan 1 and Dec 31 move by a YEAR as well as a day, and a date in each
   * DST half proves the offset is not hard-coded. A `toISOString()` write would
   * fail all six for any negative-offset zone; a `new Date(wire)` read would
   * open the calendar on the wrong day and fail them all everywhere east of it.
   *
   * One test per date, each on its own fresh mount (beforeEach / afterEach):
   * the popover portals its calendar to the body and Radix keeps it there while
   * open, so a shared root would leave the previous date's day cells in the
   * document. Six mounts and six calendar walks in ONE test outran the 5 s
   * timeout under full-suite load.
   */
  it.each([
    ['2026-01-01', 'year boundary, and the date most likely to slip backwards'],
    ['2026-12-31', 'the other year boundary'],
    ['2026-03-14', 'standard time (US)'],
    ['2026-07-04', 'daylight saving time (US)'],
    ['2026-02-28', 'month boundary'],
    ['2028-02-29', 'a leap day, which an off-by-one would land on the 28th/1st'],
  ])('picking a date sends the SAME YYYY-MM-DD the old input did: %s (%s)', async (wire) => {
    installFetch(JIRA_DATE)
    const onCreate = await render({ provider: 'jira', providerName: 'Jira' })
    await pickDate('Due date', wire)
    await clickCreate()
    expect(onCreate, `picking ${wire}`).toHaveBeenCalledWith({ due_date: wire })
  })

  /**
   * The READ direction, which the write test above cannot catch on its own.
   *
   * A value already on the form is parsed back into the calendar, and if that
   * parse went through UTC the picker would open on — and re-emit — the day
   * BEFORE. Re-picking the same day it is already showing must be a no-op on
   * the wire, which is only true if read and write agree.
   */
  it('round-trips a date through the calendar without moving it', async () => {
    installFetch(JIRA_DATE)
    const onCancel = vi.fn()
    const onCreate = await render({ provider: 'jira', providerName: 'Jira', onCancel })

    await pickDate('Due date', '2026-01-01')
    // Using the calendar must not leave compose — the guard on the helper's
    // popover-closing gesture, which would otherwise fire the strip's Escape.
    expect(onCancel).not.toHaveBeenCalled()
    // The chip displays the date it was given, in local terms — a UTC parse
    // would render "Dec 31, 2025" here.
    expect(dateChip('Due date')!.textContent).toContain('Jan 1, 2026')

    // Re-pick the very same day from the already-seeded calendar.
    await pickDate('Due date', '2026-01-01')
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({ due_date: '2026-01-01' })
  })

  it('clears through the chip’s X, since a calendar cannot say "no date"', async () => {
    installFetch(JIRA_DATE)
    const onCreate = await render({ provider: 'jira', providerName: 'Jira' })
    await pickDate('Due date', '2026-03-14')
    expect(dateChip('Due date')!.textContent).toContain('Mar 14, 2026')
    await clearDate('Due date')
    // Back to naming itself, and the clear travels as an explicit null so the
    // push suppresses its fallback.
    expect(dateChip('Due date')!.textContent).toContain('Due date')
    await clickCreate()
    expect(onCreate).toHaveBeenCalledWith({ due_date: null })
  })

  it('STACK keeps the native input — the sidebar was never the chip row', async () => {
    installFetch(JIRA_DATE)
    await render({ provider: 'jira', providerName: 'Jira', layout: 'stack' })
    expect(dateInput('Due date')).toBeTruthy()
    expect(dateInput('Due date')!.getAttribute('type')).toBe('date')
  })
})

// ---------------------------------------------------------------------------
// WHAT THE STRIP NO LONGER OFFERS
// ---------------------------------------------------------------------------

/**
 * NEW. Two controls were deliberately REMOVED from the strip, and both are the
 * kind of thing a later change re-adds by accident because each looks like an
 * obvious omission on its own.
 */
describe('PushComposePanel — the strip stops offering what the card already says', () => {
  const BASE = {
    config: { cloud_id: 'cloud-1', site_name: 'dial8', project_id: 'proj-1', project_key: 'ENG', issue_type_id: 'it-1' },
    jiraProjects: [{ id: 'proj-1', key: 'ENG', name: 'Engineering' }],
    jiraIssueTypes: [{ id: 'it-1', name: 'Task' }],
  }

  it('NO TITLE FIELD — the card renders the title', async () => {
    installFetch(BASE)
    await render({ provider: 'jira', providerName: 'Jira', defaultTitle: 'Ship the thing' })
    expect(inputByLabel('Title')).toBeUndefined()
    expect(container.querySelector('[data-compose-field="Title"]')).toBeNull()
    // And the title is not smuggled in as read-only text either — the strip is
    // properties, and the title is the card's heading above it.
    expect(container.querySelector('[data-compose-scroller]')!.textContent).not.toContain(
      'Ship the thing',
    )
  })

  /**
   * The site caption is gone because it named a value v1 cannot change. Liam's
   * own Jira site is called "dial8", so on a Dial8 screen "In dial8" read as
   * noise rather than as context — which is the fixture used here.
   */
  it('NO "In {site}" CAPTION — the site rides on the project chip instead', async () => {
    installFetch(BASE)
    await render({ provider: 'jira', providerName: 'Jira' })

    expect(container.querySelector('[data-compose-site]')).toBeNull()
    expect(container.querySelector('[data-compose-scroller]')!.textContent).not.toContain('In dial8')

    // Still reachable, on the field the site actually scopes.
    const project = container.querySelector('[data-compose-project-trigger]')!
    expect(project.getAttribute('title')).toBe('In dial8')
  })

  it('the stack sidebar drops the title field too', async () => {
    // Consistency: the detail panel's header already shows the title, so a
    // second editable copy in its properties column has the same problem.
    installFetch(BASE)
    await render({ provider: 'jira', providerName: 'Jira', layout: 'stack' })
    expect(inputByLabel('Title')).toBeUndefined()
  })
})
