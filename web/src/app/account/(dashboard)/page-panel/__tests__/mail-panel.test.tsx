// @vitest-environment jsdom
/**
 * Mail's panel: its sub-nav (mail-panel.tsx; Liam, 11-11: "see and select
 * all the accounts you have selected all the inbox, faves, sent... and any
 * tags that are available for email"). Registered for `mail`: it holds the
 * slot while the Mail page's own card is in front, once that card says where
 * it is (mail-card-controls.ts). Accounts, then the folders (counts where the
 * page shows one), then Tags when there are any; each row moves the card
 * through what the card says, the lit rows follow the card, not the click,
 * and it is the full-screen card's one account and folder control from
 * `md` up (Liam, 11-11): shown while open, room or not; leaving the card's
 * side, it clears the tag it set. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useSyncExternalStore } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  accounts: [] as Array<{ id: string; provider: 'google'; capability: 'email'; account_email: string; display_name: string | null; color: string; is_enabled: boolean }>,
  labels: [] as Array<{ id: string; name: string; color: string; group_name: null; scopes: null; created_at: string }>,
  labelReads: 0,
  openSettings: vi.fn(),
}))

vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-home' }))
vi.mock('@/components/desktop-titlebar', () => ({ useHasTrafficLights: () => false, useIsDesktop: () => false }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/account' }))
vi.mock('../../settings-overlay', () => ({ useOptionalSettingsOverlay: () => ({ openSettings: hoisted.openSettings }) }))
vi.mock('@/components/account-filter-dropdown', () => ({ useConnectedAccounts: () => hoisted.accounts }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({
  useScopedLabels: (scope: string) => {
    if (scope === 'email_thread') hoisted.labelReads++
    return { labels: hoisted.labels, grouped: [], loading: false }
  },
}))
vi.mock('../../side-panels/side-panels', async () => {
  const store = await import('../../side-panels/side-panel-store')
  return {
    PANEL_TOP: '6px',
    SLIDE_CLASS: 'transition-[translate,visibility]',
    SLIDE_STYLE: {},
    useComposerReserve: () => 0,
    useSidePanelState: () => useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState),
  }
})

import { PAGE_PANELS, PagePanelHost, pageKeyOf } from '../page-panel'
import { MailPanel } from '../mail-panel'
import * as store from '../../side-panels/side-panel-store'
import { holdFrontCard } from '@/components/chat-cards/front-card'
import {
  __resetMailCardsForTests,
  publishMailCard,
  type MailCardControls,
} from '@/components/chat-cards/mail-card-controls'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { KEEP_PLACE_ATTR, __resetSelectedPlaceForTests, selectedPlace } from '../../rail/selected-place'

const MAIL_CARD = 'card-mail-page'
const mailSpec = () => CARD_PAGES.find((p) => p.slug === 'mail')!.spec(new Date()) as CardSpec

let container: HTMLDivElement
let root: Root
let releases: Array<() => void> = []
const calls: string[] = []

function controls(over: Partial<MailCardControls> = {}): MailCardControls {
  return {
    cardId: MAIL_CARD,
    folder: 'inbox',
    accounts: null,
    labelId: null,
    counts: { inbox_unread: 4, review: 2, drafts: 1 },
    setFolder: (f) => calls.push(`folder:${f}`),
    setAccounts: (a) => calls.push(`accounts:${a ? a.join('+') : 'all'}`),
    setLabel: (l) => calls.push(`label:${l ?? 'none'}`),
    show: () => calls.push('show'),
    ...over,
  }
}

const account = (id: string, email: string, color = '#3b82f6') => ({
  id, provider: 'google' as const, capability: 'email' as const, account_email: email, display_name: null, color, is_enabled: true,
})
const label = (id: string, name: string, color: string) => ({ id, name, color, group_name: null, scopes: null, created_at: '2026-11-01T00:00:00Z' })

beforeEach(() => {
  calls.length = 0
  releases = []
  hoisted.accounts = [account('acct-work', 'sam@northwind.example'), account('acct-home', 'sam@home.example', '#22c55e')]
  hoisted.labels = []
  hoisted.labelReads = 0
  hoisted.openSettings.mockReset()
  window.localStorage.clear()
  __resetSelectedPlaceForTests()
  __resetMailCardsForTests()
  store.resetSidePanelStore()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], next_cursor: null }) }) as Response))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  for (const release of releases) act(() => release())
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {})
}

function Row() {
  const state = useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState)
  return <PagePanelHost mode={store.pagePanelWanted(state) ? 'room' : 'off'} />
}

async function openMailPage(id = MAIL_CARD) {
  act(() => {
    releases.push(holdFrontCard({ id, spec: mailSpec(), close: () => {} }))
  })
  await flush()
}

async function showPanel(over: Partial<MailCardControls> = {}) {
  act(() => root.render(<Row />))
  await openMailPage()
  act(() => publishMailCard(controls(over)))
  await flush()
}

const panel = () => container.querySelector<HTMLElement>('aside[data-page-panel="mail"]')
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-mail-row]')]
const keys = () => rows().map((r) => r.getAttribute('data-mail-row'))
const row = (key: string) => container.querySelector<HTMLButtonElement>(`[data-mail-row="${key}"]`)!
const labelOf = (key: string) => row(key).querySelector('[data-mail-label]')!.textContent
const countOf = (key: string) => row(key).querySelector('[data-mail-count] [aria-hidden]')?.textContent ?? null
const lit = () => rows().filter((r) => r.getAttribute('aria-current') === 'true').map((r) => r.getAttribute('data-mail-row'))
const headings = () => [...container.querySelectorAll('[data-mail-section] h3')].map((h) => h.textContent)

describe('the Mail sub-nav', () => {
  it('is Mail’s registered panel', () => {
    expect(PAGE_PANELS.mail).toBe(MailPanel)
    expect(pageKeyOf('mail')).toBe('mail')
  })

  it('holds the slot on the Mail page from its first commit, before its card says anything: Accounts, the folders, no Tags without any; the counts come with the card', async () => {
    act(() => root.render(<Row />))
    // Not shown yet: no labels read.
    expect(hoisted.labelReads).toBe(0)
    await openMailPage()
    expect(selectedPlace()).toBe('mail')
    // No card has said where it is yet (Liam, 11-11: "it goes away completely and reappears"): the rows are there,
    // the page's default lit (Inbox, every mailbox), no counts yet.
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(store.getSidePanelState()).toMatchObject({ pagePanel: true, pagePanelPage: true })
    expect(keys()).toContain('folder:inbox')
    expect(lit()).toEqual(['account:all', 'folder:inbox'])
    expect(container.querySelector('[data-mail-count]')).toBeNull()
    act(() => publishMailCard(controls()))
    await flush()
    expect(countOf('folder:inbox')).toBe('4')
    expect(panel()!.getAttribute('aria-label')).toBe('Mail')
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(keys()).toEqual([
      'account:all', 'account:acct-work', 'account:acct-home', 'connect',
      'folder:inbox', 'folder:review', 'folder:starred', 'folder:drafts', 'folder:sent',
      'folder:archive', 'folder:spam', 'folder:trash',
    ])
    expect(rows().map((r) => r.querySelector('[data-mail-label]')!.textContent)).toEqual([
      'All accounts', 'sam@northwind.example', 'sam@home.example', 'Connect another account',
      'Inbox', 'To review', 'Starred', 'Drafts', 'Sent', 'Archive', 'Spam', 'Trash',
    ])
    expect(headings()).toEqual(['Accounts'])
    // The everyday folders, then (a section of their own) where mail is put away.
    expect([...container.querySelectorAll('[data-mail-section]')].map((s) => s.getAttribute('data-mail-section'))).toEqual(['accounts', 'folders', 'library'])
    // A press in it keeps the page selected.
    expect(rows()[0].closest(`[${KEEP_PLACE_ATTR}]`)).not.toBeNull()
  })

  it('a row pressed before the card says where it is: the latest move waits, then moves the card once it says', async () => {
    act(() => root.render(<Row />))
    await openMailPage()
    act(() => row('folder:sent').click())
    act(() => row('folder:starred').click())
    expect(calls).toEqual([])
    act(() => publishMailCard(controls()))
    await flush()
    expect(calls).toEqual(['folder:starred'])
    // Inbox pressed before the card said, the card on Inbox in front: nothing more.
    calls.length = 0
    __resetMailCardsForTests()
    act(() => root.render(<Row />))
    await flush()
    act(() => row('folder:inbox').click())
    act(() => publishMailCard(controls()))
    await flush()
    expect(calls).toEqual([])
  })

  it('shows the counts the page shows: Inbox’s unread, To review, Drafts; none where there are none', async () => {
    await showPanel({ counts: { inbox_unread: 4, review: 2, drafts: 1, starred: 0 } })
    expect(countOf('folder:inbox')).toBe('4')
    expect(row('folder:inbox').textContent).toContain('4 unread')
    expect(countOf('folder:review')).toBe('2')
    expect(countOf('folder:drafts')).toBe('1')
    expect(countOf('folder:starred')).toBeNull()
    expect(countOf('folder:sent')).toBeNull()
  })

  it('accounts: all lit by default; a click sets the card’s filter (one mailbox, or all); lit follows the card', async () => {
    await showPanel()
    expect(lit()).toEqual(['account:all', 'folder:inbox'])
    row('account:acct-home').click()
    expect(calls).toEqual(['accounts:acct-home'])
    // Nothing lit from the click: the card hasn't said so yet.
    expect(lit()).toEqual(['account:all', 'folder:inbox'])
    act(() => publishMailCard(controls({ accounts: ['acct-home'] })))
    await flush()
    expect(lit()).toEqual(['account:acct-home', 'folder:inbox'])
    row('account:all').click()
    expect(calls).toEqual(['accounts:acct-home', 'accounts:all'])
    // Picked again where it already is: nothing more.
    calls.length = 0
    row('account:acct-home').click()
    expect(calls).toEqual([])
  })

  it('with one account: no All accounts row, that one lit, and the connect row', async () => {
    hoisted.accounts = [account('acct-work', 'sam@northwind.example')]
    await showPanel()
    expect(keys().slice(0, 2)).toEqual(['account:acct-work', 'connect'])
    expect(lit()).toEqual(['account:acct-work', 'folder:inbox'])
  })

  it('with no account connected: the connect row alone, saying "Connect an account" (no "another")', async () => {
    hoisted.accounts = []
    await showPanel()
    expect(keys().slice(0, 2)).toEqual(['connect', 'folder:inbox'])
    expect(labelOf('connect')).toBe('Connect an account')
  })

  it('Connect another account opens the connectors settings, where an email account connects', async () => {
    await showPanel()
    expect(labelOf('connect')).toBe('Connect another account')
    row('connect').click()
    expect(hoisted.openSettings).toHaveBeenCalledWith('connectors')
    expect(calls).toEqual([])
  })

  it('folders: a click moves the card there (its history step), the lit row follows the card', async () => {
    await showPanel()
    row('folder:sent').click()
    expect(calls).toEqual(['folder:sent'])
    expect(lit()).toContain('folder:inbox')
    act(() => publishMailCard(controls({ folder: 'sent' })))
    await flush()
    expect(lit()).toEqual(['account:all', 'folder:sent'])
    // Where the card is already: nothing more.
    row('folder:sent').click()
    expect(calls).toEqual(['folder:sent'])
  })

  it('tags: only when there are any, a dot in the label’s colour; a click filters, again clears; lit instead of the folder', async () => {
    hoisted.labels = [label('lbl-client', 'Client', '#ef4444'), label('lbl-invoice', 'Invoices', '#f59e0b')]
    await showPanel()
    expect(headings()).toEqual(['Accounts', 'Tags'])
    expect(keys().slice(-2)).toEqual(['label:lbl-client', 'label:lbl-invoice'])
    expect(row('label:lbl-client').querySelector<HTMLElement>('[data-mail-tag-dot]')!.style.backgroundColor).toBe('rgb(239, 68, 68)')
    row('label:lbl-client').click()
    expect(calls).toEqual(['label:lbl-client'])
    act(() => publishMailCard(controls({ labelId: 'lbl-client' })))
    await flush()
    // The tag lit, no folder (the list is the tag's, in every folder).
    expect(lit()).toEqual(['account:all', 'label:lbl-client'])
    row('label:lbl-client').click()
    expect(calls).toEqual(['label:lbl-client', 'label:none'])
    // A folder, even the card's own, clears the tag (the card's setFolder does).
    row('folder:inbox').click()
    expect(calls).toEqual(['label:lbl-client', 'label:none', 'folder:inbox'])
  })

  it('a row with another card in front brings the page’s card back first', async () => {
    act(() => root.render(<Row />))
    await openMailPage()
    act(() => publishMailCard(controls()))
    await flush()
    // A record opened over the page as its own card (the page stays selected).
    act(() => {
      releases.push(holdFrontCard({ id: 'card-contact', spec: mailSpec(), close: () => {} }))
    })
    await flush()
    row('folder:inbox').click()
    expect(calls).toEqual(['show', 'folder:inbox'])
  })

  it('is the page’s one control (pinned: shown while open, room or not); closed by its button, off', async () => {
    await showPanel()
    expect(store.getSidePanelState()).toMatchObject({ pagePanelPage: true, pagePanelShown: true })
    act(() => store.setPagePanelOpen(false))
    await flush()
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('off')
    expect(store.getSidePanelState().pagePanelShown).toBe(false)
  })

  it('leaving the card’s side clears the tag it set there (nothing else shows it); no tag, nothing to clear', async () => {
    await showPanel({ labelId: 'lbl-client' })
    act(() => store.setPagePanelOpen(false))
    await flush()
    expect(calls).toEqual(['label:none'])
    calls.length = 0
    act(() => store.setPagePanelOpen(true))
    await flush()
    act(() => publishMailCard(controls()))
    await flush()
    act(() => store.setPagePanelOpen(false))
    await flush()
    expect(calls).toEqual([])
  })
})
