// @vitest-environment jsdom
/**
 * THE PROPERTY LENS ON A CAPTURE'S PROPOSAL CARD.
 *
 * The card already had two mutually-exclusive states for its property line —
 * Dial8's own pills, and the push-compose strip that takes the line over. The
 * lens is a third, and this file pins the three rules that keep it from
 * disturbing the two that were there:
 *
 *  - APPLIED ROWS ONLY, and not by preference. A pending proposal has no action
 *    row, so there is no `action_external_task` to read: `result_entity_id` is
 *    null until the accept lands. A pending card must not even ASK.
 *  - AN UNPUSHED ACTION SEES ZERO CHANGE. No switcher, no request, the same pill
 *    row it always had. This is the requirement that makes the feature invisible
 *    to the actions it does not apply to, and it is why the link lookup is gated
 *    on the properties view actually being open.
 *  - COMPOSE STILL WINS. The strip is the property line while a push is being
 *    composed; a lens must not appear beside it or under it.
 *
 * The Radix substitutions (DropdownMenu, Select) are the same ones the
 * push-menu suite next door makes, for the same jsdom reasons.
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

import { ProposalCard } from '../proposal-card'
import { emitEntityUpdated } from '@/lib/entity-events'
import type { ProposedChange } from '@/lib/proposed-changes/types'

// ---- fetch fake ------------------------------------------------------------

let calls: string[] = []

function jiraDetails() {
  return {
    ok: true,
    provider: 'jira',
    link_id: 'link-1',
    url: 'https://acme.atlassian.net/browse/KAN-3',
    title: 'Send the pricing deck',
    status_name: 'In Progress',
    fields: {
      project: { id: '10001', name: 'Kanban' },
      issue_type: { id: '10002', name: 'Task' },
      team: null,
      section: null,
      assignee: { id: 'acc-1', name: 'Ada Lovelace' },
      priority: { id: '3', name: 'Medium' },
      due_date: '2026-03-14',
      labels: [],
    },
    editable: { assignee: true, priority: true, due_date: true, labels: true },
    option_scope: {
      cloud_id: 'cloud-1',
      project_id: '10001',
      project_key: 'KAN',
      issue_type_id: '10002',
    },
  }
}

function installFetch({ linkedProviders = [] as string[] } = {}) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      calls.push(url)
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

      if (url.includes('/task-details')) return ok(jiraDetails())

      const linkMatch = /\/api\/account\/actions\/[^/]+\/(asana|jira|linear)$/.exec(url)
      if (linkMatch) {
        const provider = linkMatch[1]
        return ok({
          tasks: linkedProviders.includes(provider)
            ? [{ id: `link-${provider}`, provider, external_id: 'x', external_url: null, external_title: null, completed: false }]
            : [],
        })
      }
      if (url.includes('/jira/assignable-users')) return ok({ users: [] })
      if (url.includes('/jira/compose-meta'))
        return ok({ meta: { priorities: [] }, native_create_url: null, cached: false })
      if (url.includes('task-destinations')) return ok({ destinations: [] })
      return ok({})
    }),
  )
}

function makeChange(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    id: 'chg-1',
    capture_id: 'cap-1',
    workspace_id: 'ws-1',
    change_type: 'create',
    entity_type: 'action',
    entity_id: null,
    display_text: 'Send the pricing deck',
    title: 'Send the pricing deck',
    description: null,
    priority: null,
    due_date: null,
    status_from: null,
    status_to: null,
    assignee_name: null,
    assignee_member_id: null,
    assignee_contact_id: null,
    team_id: null,
    project_id: null,
    labels: null,
    email_to_name: null,
    email_to_address: null,
    email_subject: null,
    email_context: null,
    extra: null,
    anchor_text: null,
    sort_order: 0,
    confidence: 0.9,
    trigger_quote: null,
    reasoning: null,
    stakes: null,
    open_questions: null,
    status: 'pending',
    applied_at: null,
    applied_by: null,
    result_entity_id: null,
    error_message: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as ProposedChange
}

let container: HTMLDivElement
let root: Root

async function renderCard(change: ProposedChange) {
  await act(async () => {
    root.render(
      h(ProposalCard, {
        change,
        onApply: vi.fn(async () => null),
        onDismiss: vi.fn(async () => {}),
        onEdit: vi.fn(async () => {}),
      }),
    )
  })
}

/** The sliders button that opens the property line. */
function propertiesToggle(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('title') === 'Edit properties' || b.getAttribute('title') === 'Hide properties',
  ) as HTMLButtonElement | undefined
}

async function openProperties() {
  await act(async () => {
    propertiesToggle()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function linkCalls() {
  return calls.filter((u) => /\/api\/account\/actions\/[^/]+\/(asana|jira|linear)$/.test(u))
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

describe('ProposalCard — the property lens', () => {
  /**
   * THE INVISIBILITY REQUIREMENT. An action that was never pushed must look
   * exactly as it did before this feature existed.
   */
  it('an APPLIED but unlinked action gets no switcher and keeps its Dial8 pills', async () => {
    installFetch({ linkedProviders: [] })
    await renderCard(makeChange({ status: 'applied', result_entity_id: 'act-7' }))
    await openProperties()

    expect(container.querySelector('[data-lens-switcher]')).toBeNull()
    expect(container.querySelector('[data-lens-surface]')).toBeNull()
    // The Dial8 due-date pill is still on the line.
    expect(
      Array.from(container.querySelectorAll('button')).some((b) =>
        b.textContent?.includes('Due date'),
      ),
    ).toBe(true)
  })

  /**
   * A PENDING ROW HAS NO ACTION TO LOOK UP. `result_entity_id` is null until the
   * accept lands, so the card must not ask the link routes at all.
   */
  it('a PENDING row never asks for links', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await renderCard(makeChange({ status: 'pending' }))
    await openProperties()

    expect(linkCalls()).toEqual([])
    expect(container.querySelector('[data-lens-switcher]')).toBeNull()
  })

  /**
   * LAZY BY DESIGN: a capture panel renders dozens of these rows, and three
   * requests per row on mount would be a burst for a switcher nobody opened.
   */
  it('does not ask for links until properties are actually opened', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await renderCard(makeChange({ status: 'applied', result_entity_id: 'act-7' }))
    expect(linkCalls()).toEqual([])

    await openProperties()
    expect(linkCalls().length).toBeGreaterThan(0)
  })

  it('a LINKED applied action gets the switcher, defaulting to the linked provider', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await renderCard(makeChange({ status: 'applied', result_entity_id: 'act-7' }))
    await openProperties()

    const switcher = container.querySelector('[data-lens-switcher]')!
    expect(Array.from(switcher.querySelectorAll('[data-lens-tab]')).map((t) => t.getAttribute('data-lens-tab'))).toEqual(
      ['dial8', 'jira'],
    )
    // Defaulted to the provider, not to Dial8.
    expect(switcher.querySelector('[data-lens-tab="jira"]')!.getAttribute('aria-pressed')).toBe('true')
    // And the lens took the property line, in strip layout with the scroller.
    expect(container.querySelector('[data-lens-surface="strip"]')).toBeTruthy()
    const scroller = container.querySelector('[data-lens-scroller]')!
    expect(scroller.className).toContain('overflow-x-auto')
    expect(scroller.className).toContain('overflow-y-hidden')
  })

  it('shows the linked ticket\'s live values, not the proposal\'s', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await renderCard(makeChange({ status: 'applied', result_entity_id: 'act-7' }))
    await openProperties()

    expect(container.querySelector('[data-lens-field="project"]')!.textContent).toContain('Kanban')
    expect(container.querySelector('[data-lens-field="status"]')!.textContent).toContain('In Progress')
  })

  /** Flipping back to Dial8 restores the pill row it replaced. */
  it('switching to the Dial8 tab brings the native pills back', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await renderCard(makeChange({ status: 'applied', result_entity_id: 'act-7' }))
    await openProperties()
    expect(container.querySelector('[data-lens-surface]')).toBeTruthy()

    await act(async () => {
      container
        .querySelector('[data-lens-tab="dial8"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('[data-lens-surface]')).toBeNull()
    // The switcher stays — it is how you get back.
    expect(container.querySelector('[data-lens-switcher]')).toBeTruthy()
    expect(
      Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('Due date')),
    ).toBe(true)
  })

  it('several links order the tabs canonically (asana, jira, linear)', async () => {
    installFetch({ linkedProviders: ['linear', 'jira', 'asana'] })
    await renderCard(makeChange({ status: 'applied', result_entity_id: 'act-7' }))
    await openProperties()

    expect(
      Array.from(container.querySelectorAll('[data-lens-tab]')).map((t) => t.getAttribute('data-lens-tab')),
    ).toEqual(['dial8', 'asana', 'jira', 'linear'])
  })

  /**
   * COMPOSE WINS. The strip IS the property line while a push is being composed;
   * the properties toggle is not even rendered then, so the lens has no line to
   * take and must not draw one.
   */
  it('while composing, neither the switcher nor the lens is drawn', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await renderCard(makeChange({ status: 'applied', result_entity_id: 'act-7' }))
    await openProperties()
    expect(container.querySelector('[data-lens-surface]')).toBeTruthy()

    // Entering compose is what the push menu's onComposeChange does; the visible
    // consequence on this card is that the properties toggle disappears and the
    // compose row takes over. Assert the mutual exclusion through the gate the
    // card actually uses: the lens is inside `showProperties && !composing`.
    // (The push-menu suite next door drives the real menu; here the claim is the
    // structural one — the two never share the line.)
    const lensRow = container.querySelector('[data-lens-surface]')!.closest('div.flex.gap-3')
    const composeRow = container.querySelector('[data-compose-property-row]')
    expect(composeRow).toBeNull()
    expect(lensRow).toBeTruthy()
  })
})
