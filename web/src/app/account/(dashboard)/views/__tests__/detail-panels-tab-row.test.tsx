// @vitest-environment jsdom
/**
 * A detail page's sections on its own first row, from the far left (Liam,
 * 11-23: "I want to put it back in the header of the pages but make it look
 * really nice and clean like linear does … it should start to the far left
 * even though the page content is indented"): in a card and on their own
 * alike, the contact's and the company's sections are a tablist in the page's
 * first row, on the 18px line a list's view tabs start on, counted; a press
 * switches the section, and the card's header holds none of them.
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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
  useCurrentMemberId: () => 'm-1',
  useWorkspaces: () => ({ workspaces: [], currentId: 'ws-1', refresh: vi.fn() }),
  useSwitchWorkspace: () => vi.fn(),
}))
vi.mock('@/components/views/use-properties-visible', () => ({ usePropertiesVisible: () => false }))
vi.mock('../note-editor', () => ({ NoteEditor: () => h('div', { 'data-note-editor': '' }) }))
vi.mock('../../components/comments', () => ({ Comments: () => h('div', { 'data-comments': '' }) }))
vi.mock('../contact-details-tab', () => ({ ContactDetailsTab: () => h('div', { 'data-details-tab': 'contact' }) }))
vi.mock('../company-details-tab', () => ({ CompanyDetailsTab: () => h('div', { 'data-details-tab': 'company' }) }))
vi.mock('@/components/sequences/add-to-sequence-dialog', () => ({ AddToSequenceDialog: () => null }))
vi.mock('../../sequences/api', () => ({ fetchContactEnrollments: async () => [] }))
vi.mock('@/components/email/email-thread-detail', () => ({ EmailThreadDetail: () => null }))
vi.mock('@/components/views/unified-view-layout', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  UnifiedViewLayout: ({ entityType }: { entityType: string }) => h('div', { 'data-embedded-list': entityType }),
}))

import { ContactDetailPanel } from '../contact-detail-panel'
import { CompanyDetailPanel } from '../company-detail-panel'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'
import { WindowPropertiesProvider } from '@/components/views/window-properties'

const contact = {
  id: 'ct-1',
  full_name: 'Ada Example',
  first_name: 'Ada',
  last_name: 'Example',
  email: 'ada@example.test',
  secondary_emails: [],
  phone: null,
  job_title: 'CTO',
  department: null,
  linkedin_url: null,
  avatar_url: null,
  relationship_type: 'lead',
  relationship_strength: 'neutral',
  last_interaction_at: null,
  interaction_count: 0,
  next_followup_at: null,
  visibility: 'workspace',
  member_id: null,
  created_by_member_id: null,
  notes: null,
  tags: [],
  metadata: null,
  company: { id: 'co-1', name: 'Fernhill', domain: 'fernhill.test', industry: null },
  interactions: [],
  captures: [{ id: 'cap-1' }],
  email_threads: [],
  open_actions: [],
  actions: [{ id: 'a-1' }, { id: 'a-2' }],
}

const company = {
  id: 'co-1',
  name: 'Fernhill',
  domain: 'fernhill.test',
  industry: null,
  description: null,
  website: null,
  logo_url: null,
  employee_count: null,
  location: null,
  notes: null,
  tags: [],
  metadata: null,
  contacts: [{ id: 'ct-1', full_name: 'Ada Example' }],
  captures: [],
  actions: [],
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      if (url.startsWith('/api/account/contacts/ct-1')) return { ok: true, status: 200, json: async () => ({ contact }) }
      if (url.startsWith('/api/account/companies/co-1')) return { ok: true, status: 200, json: async () => ({ company }) }
      return { ok: true, status: 200, json: async () => ({ companies: [], claims: [], contacts: [] }) }
    }),
  )
})

let container: HTMLDivElement
let right: HTMLDivElement
/** The card body's top row (card-body.tsx PropertiesRow), the card's whole width. */
let top: HTMLDivElement
let root: Root

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  top.remove()
  vi.unstubAllGlobals()
})

/**
 * In a card as the card draws it, with its top row (`pageTop`): the sections stand there (Liam, 11-24: "why is
 * it that on prod the tabs are indented?"). `covered`: a card's page under a record, whose slots have no top row.
 */
async function mount(node: ReactNode, { inCard, withProperties = false, covered = false }: { inCard: boolean; withProperties?: boolean; covered?: boolean }) {
  container = document.createElement('div')
  right = document.createElement('div')
  top = document.createElement('div')
  document.body.append(right, top, container)
  root = createRoot(container)
  let tree = node
  if (withProperties) tree = h(WindowPropertiesProvider, null, tree)
  if (inCard) tree = h(CardHeaderSlotsProvider, { value: covered ? { left: null, right } : { left: null, right, pageTop: top } }, tree)
  await act(async () => root.render(tree))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const row = () => container.querySelector<HTMLElement>('[data-detail-tabs=""]')!
/** The sections, wherever they stand: the card's top row, else the page's own. */
const tabs = () => (top.querySelector<HTMLElement>('[role="tablist"]') ?? row().querySelector<HTMLElement>('[role="tablist"]'))!

describe('the contact’s sections', () => {
  it('in a card: the card’s top row, from its corner, with its counts; a press switches the section; none in the header, the page’s own row left empty', async () => {
    await mount(h(ContactDetailPanel, { contactId: 'ct-1', onClose: vi.fn() }), { inCard: true, withProperties: true })
    expect(right.querySelector('[role="tablist"]')).toBeNull()
    expect(top.querySelector('[role="tablist"]')).not.toBeNull()
    expect(tabs().parentElement!.className).toContain('px-2.5')
    // The page's own row: nothing left in it (its actions in Properties), so it hides (empty:hidden).
    expect(row().childElementCount).toBe(0)
    expect(row().className).toContain('empty:hidden')
    expect(tabs().getAttribute('aria-label')).toBe('Contact')
    expect(Array.from(tabs().querySelectorAll('[data-detail-tab]')).map((b) => b.getAttribute('data-detail-tab'))).toEqual([
      'overview',
      'details',
      'actions',
      'captures',
      'sequences',
      'deals',
      'agents',
    ])
    expect(tabs().querySelector('[data-detail-tab="overview"]')!.getAttribute('aria-selected')).toBe('true')
    expect(tabs().querySelector('[data-detail-tab="actions"]')!.textContent).toBe('Actions2')
    expect(tabs().querySelector('[data-detail-tab="captures"]')!.textContent).toBe('Captures1')

    await act(async () => tabs().querySelector<HTMLButtonElement>('[data-detail-tab="details"]')!.click())
    expect(tabs().querySelector('[data-detail-tab="details"]')!.getAttribute('aria-selected')).toBe('true')
    expect(tabs().querySelector('[data-detail-tab="overview"]')!.getAttribute('aria-selected')).toBe('false')
    expect(container.querySelector('[data-details-tab="contact"]')).not.toBeNull()
  })

  it('covered by a record (its slots have no top row): its sections stay in its own row, so the top row holds only the record’s', async () => {
    await mount(h(ContactDetailPanel, { contactId: 'ct-1', onClose: vi.fn() }), { inCard: true, withProperties: true, covered: true })
    expect(top.childElementCount).toBe(0)
    expect(row().querySelectorAll('[role="tab"]').length).toBe(7)
    expect(right.querySelector('[role="tablist"]')).toBeNull()
  })

  it('on its own: the same row', async () => {
    await mount(h(ContactDetailPanel, { contactId: 'ct-1', onClose: vi.fn() }), { inCard: false })
    expect(right.childElementCount).toBe(0)
    const pill = Array.from(tabs().querySelectorAll('button')).find((b) => b.textContent === 'Details')!
    expect(pill).toBeTruthy()
    await act(async () => pill.click())
    expect(container.querySelector('[data-details-tab="contact"]')).not.toBeNull()
  })
})

describe('the company’s sections', () => {
  it('in a card: the card’s top row with People counted; a press switches the section', async () => {
    await mount(h(CompanyDetailPanel, { companyId: 'co-1', onClose: vi.fn() }), { inCard: true })
    expect(right.querySelector('[role="tablist"]')).toBeNull()
    expect(top.querySelector('[role="tablist"]')).not.toBeNull()
    expect(Array.from(tabs().querySelectorAll('[data-detail-tab]')).map((b) => b.textContent)).toEqual(['Overview', 'Details', 'People1', 'Deals', 'Agents'])
    await act(async () => tabs().querySelector<HTMLButtonElement>('[data-detail-tab="details"]')!.click())
    expect(container.querySelector('[data-details-tab="company"]')).not.toBeNull()
  })

  it('on its own: the same row', async () => {
    await mount(h(CompanyDetailPanel, { companyId: 'co-1', onClose: vi.fn() }), { inCard: false })
    expect(right.childElementCount).toBe(0)
    expect(Array.from(tabs().querySelectorAll('button')).some((b) => b.textContent === 'Overview')).toBe(true)
  })
})
