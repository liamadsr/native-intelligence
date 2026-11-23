// @vitest-environment jsdom
/**
 * A detail page's sections in a card's header (Liam, 11-23: "these details
 * view pages like projects and pull request and other pages that show the
 * different pages at the top … feel out of place"): in a card, the contact's
 * and the company's sections are a capsule in the card's right slot, a press
 * there switches the section, and the page's own row keeps only what is left
 * (nothing at all once the actions sit in the Properties popover). On their
 * own, the row of pills, as before.
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
let root: Root

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  vi.unstubAllGlobals()
})

async function mount(node: ReactNode, { inCard, withProperties = false }: { inCard: boolean; withProperties?: boolean }) {
  container = document.createElement('div')
  right = document.createElement('div')
  document.body.append(right, container)
  root = createRoot(container)
  let tree = node
  if (withProperties) tree = h(WindowPropertiesProvider, null, tree)
  if (inCard) tree = h(CardHeaderSlotsProvider, { value: { left: null, right } }, tree)
  await act(async () => root.render(tree))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const capsule = () => right.querySelector<HTMLElement>('[data-detail-tabs="header"]')
const row = () => container.querySelector<HTMLElement>('[data-detail-tabs=""]')!

describe('the contact’s sections', () => {
  it('in a card: a capsule in the header with its counts; a press switches the section; none in the page', async () => {
    await mount(h(ContactDetailPanel, { contactId: 'ct-1', onClose: vi.fn() }), { inCard: true })
    const tabs = capsule()!
    expect(tabs).not.toBeNull()
    expect(tabs.getAttribute('role')).toBe('tablist')
    expect(Array.from(tabs.querySelectorAll('[data-detail-tab]')).map((b) => b.getAttribute('data-detail-tab'))).toEqual([
      'overview',
      'details',
      'actions',
      'captures',
      'sequences',
      'deals',
      'agents',
    ])
    expect(tabs.querySelector('[data-detail-tab="overview"]')!.getAttribute('aria-selected')).toBe('true')
    expect(tabs.querySelector('[data-detail-tab="actions"]')!.textContent).toBe('Actions2')
    expect(tabs.querySelector('[data-detail-tab="captures"]')!.textContent).toBe('Captures1')
    // No pills left in the page's own row (the actions stay inline without a Properties popover).
    expect(row().textContent).not.toContain('Overview')
    expect(row().className).toContain('empty:hidden')

    await act(async () => tabs.querySelector<HTMLButtonElement>('[data-detail-tab="details"]')!.click())
    expect(tabs.querySelector('[data-detail-tab="details"]')!.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-details-tab="contact"]')).not.toBeNull()
  })

  it('in a card with a Properties popover: the row is left empty, so it hides', async () => {
    await mount(h(ContactDetailPanel, { contactId: 'ct-1', onClose: vi.fn() }), { inCard: true, withProperties: true })
    expect(capsule()).not.toBeNull()
    expect(row().childNodes.length).toBe(0)
  })

  it('on its own: the row of pills, as before, and nothing in a header', async () => {
    await mount(h(ContactDetailPanel, { contactId: 'ct-1', onClose: vi.fn() }), { inCard: false })
    expect(right.childElementCount).toBe(0)
    const pill = Array.from(row().querySelectorAll('button')).find((b) => b.textContent === 'Details')!
    expect(pill).toBeTruthy()
    await act(async () => pill.click())
    expect(container.querySelector('[data-details-tab="contact"]')).not.toBeNull()
  })
})

describe('the company’s sections', () => {
  it('in a card: a capsule with People counted; a press switches the section', async () => {
    await mount(h(CompanyDetailPanel, { companyId: 'co-1', onClose: vi.fn() }), { inCard: true })
    const tabs = capsule()!
    expect(Array.from(tabs.querySelectorAll('[data-detail-tab]')).map((b) => b.textContent)).toEqual(['Overview', 'Details', 'People1', 'Deals', 'Agents'])
    await act(async () => tabs.querySelector<HTMLButtonElement>('[data-detail-tab="details"]')!.click())
    expect(container.querySelector('[data-details-tab="company"]')).not.toBeNull()
  })

  it('on its own: the row of pills', async () => {
    await mount(h(CompanyDetailPanel, { companyId: 'co-1', onClose: vi.fn() }), { inCard: false })
    expect(right.childElementCount).toBe(0)
    expect(Array.from(row().querySelectorAll('button')).some((b) => b.textContent === 'Overview')).toBe(true)
  })
})
