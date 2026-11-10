// @vitest-environment jsdom
/**
 * The contact panel's "Find email" affordance.
 *
 * Liam, 2026-09-10: "a button on the email field if it's missing that says Find
 * email". Two things this pins from the outside:
 *
 *   • the button renders ONLY on an empty email row. On a contact who already
 *     has an address it would be noise at best, and at worst an invitation to
 *     overwrite a known-good address with a web guess.
 *   • the click dispatches `ni:find-contact-email` carrying the anchors the
 *     skill searches on — id, name, title, company, domain, LinkedIn — read
 *     off the row the user is actually looking at.
 *
 * The panel drags in the editor, the pickers and the sequences tab, none of
 * which are under test; they are stubbed to markers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

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
// The properties sidebar is WIDTH-driven (usePropertiesVisible measures the
// panel body). jsdom reports zero width, so force it open — the email row lives
// inside it and is the whole subject here.
vi.mock('@/components/views/use-properties-visible', () => ({
  usePropertiesVisible: () => true,
}))
vi.mock('../note-editor', () => ({ NoteEditor: () => h('div', { 'data-note-editor': '' }) }))
vi.mock('../../components/comments', () => ({ Comments: () => h('div', { 'data-comments': '' }) }))
vi.mock('../contact-details-tab', () => ({
  ContactDetailsTab: () => h('div', { 'data-details-tab': '' }),
}))
vi.mock('@/components/sequences/add-to-sequence-dialog', () => ({
  AddToSequenceDialog: () => null,
}))
vi.mock('../../sequences/api', () => ({ fetchContactEnrollments: async () => [] }))
vi.mock('@/components/email/email-thread-detail', () => ({ EmailThreadDetail: () => null }))

import { ContactDetailPanel } from '../contact-detail-panel'
import { FIND_CONTACT_EMAIL_EVENT } from '../../prospecting/start-event'

type ContactRow = Record<string, unknown>

/** A contact as the detail route returns it — thin, and with no email. */
function contactRow(overrides: ContactRow = {}): ContactRow {
  return {
    id: 'ct-1',
    full_name: 'Ada Lovelace',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: null,
    secondary_emails: [],
    phone: null,
    job_title: 'CTO',
    department: null,
    linkedin_url: 'https://linkedin.com/in/ada',
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
    company: { id: 'co-1', name: 'Acme', domain: 'acme.com', industry: null },
    interactions: [],
    captures: [],
    email_threads: [],
    open_actions: [],
    actions: [],
    ...overrides,
  }
}

let current: ContactRow = contactRow()

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      if (url.startsWith('/api/account/contacts/ct-1')) {
        return { ok: true, status: 200, json: async () => ({ contact: current }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ companies: [], claims: [], contacts: [] }),
      }
    }),
  )
}

let container: HTMLDivElement
let root: Root

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(h(ContactDetailPanel, { contactId: 'ct-1', onClose: vi.fn() }))
  })
}

/** The "Find email" button, by its visible label. */
function findEmailButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    /Find email|Finding/.test(b.textContent ?? ''),
  ) as HTMLButtonElement | undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  current = contactRow()
  installFetch()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the Find email button', () => {
  it('renders on a contact with no email', async () => {
    await mount()
    expect(findEmailButton()).toBeTruthy()
  })

  it('does NOT render once an address is on file', async () => {
    current = contactRow({ email: 'ada@acme.com' })
    await mount()
    expect(findEmailButton()).toBeUndefined()
  })

  it('does NOT render for a whitespace-only address either', async () => {
    // A blank-but-present string is still "no email" to the user, and the guard
    // trims for exactly that reason.
    current = contactRow({ email: '   ' })
    await mount()
    expect(findEmailButton()).toBeTruthy()
  })

  it('dispatches ni:find-contact-email with the row the user is looking at', async () => {
    await mount()
    const seen: Array<Record<string, unknown>> = []
    const listener = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener(FIND_CONTACT_EMAIL_EVENT, listener)
    try {
      await act(async () => {
        findEmailButton()!.click()
      })
    } finally {
      window.removeEventListener(FIND_CONTACT_EMAIL_EVENT, listener)
    }

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      contactId: 'ct-1',
      contactName: 'Ada Lovelace',
      jobTitle: 'CTO',
      companyName: 'Acme',
      companyDomain: 'acme.com',
      linkedinUrl: 'https://linkedin.com/in/ada',
    })
  })

  it('shows "Finding…" and disables itself after the click', async () => {
    await mount()
    await act(async () => {
      findEmailButton()!.click()
    })
    const btn = findEmailButton()!
    expect(btn.textContent).toContain('Finding')
    expect(btn.disabled).toBe(true)
  })

  it('sends null anchors rather than inventing them on a company-less contact', async () => {
    current = contactRow({ company: null, job_title: null, linkedin_url: null })
    await mount()
    const seen: Array<Record<string, unknown>> = []
    const listener = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener(FIND_CONTACT_EMAIL_EVENT, listener)
    try {
      await act(async () => {
        findEmailButton()!.click()
      })
    } finally {
      window.removeEventListener(FIND_CONTACT_EMAIL_EVENT, listener)
    }
    expect(seen[0]).toMatchObject({
      contactId: 'ct-1',
      companyName: null,
      companyDomain: null,
      jobTitle: null,
      linkedinUrl: null,
    })
  })
})
