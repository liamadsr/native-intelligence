// @vitest-environment jsdom
/**
 * Share to chat (migration 646), as people see it: the picker (with its
 * guests warning and the toast's Undo), the owner's chips under the thread's
 * subject ("Shared to #sales · Un-share"), the thread view's button, and the
 * card in team chat (live, revoked, unavailable; Open shows the thread
 * read-only with its attachments downloading through the share). fetch is
 * stubbed. Made-up people and companies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/components/read-aloud/listen-target', () => ({ ListenTarget: () => null }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({ useScopedLabels: () => ({ labels: [], grouped: [], loading: false }) }))

import { EmailShareDialog } from '../email-share-dialog'
import { EmailShareChips } from '../email-share-chips'
import { EmailShareCard } from '../email-share-card'
import { EmailThreadDetail } from '../email-thread-detail'

const SHARE = '0f8fad5b-d9cb-469f-a165-70867728950e'
const SALES = '11111111-1111-4111-8111-111111111111'
const DM = '22222222-2222-4222-8222-222222222222'

const respond = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this } }) as unknown as Response

let container: HTMLDivElement
let root: Root
let calls: Array<{ url: string; method: string; body: unknown }>
let routes: (url: string, method: string) => Response

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
const $ = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const text = () => document.body.textContent ?? ''

beforeEach(() => {
  calls = []
  routes = () => respond(404, { error: 'Not found' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
      return routes(url, method)
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function render(el: ReturnType<typeof h>) {
  await act(async () => root.render(el))
  await flush()
  await flush()
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the picker', () => {
  beforeEach(() => {
    routes = (url, method) => {
      if (url === '/api/account/email/shares/targets') {
        return respond(200, {
          targets: [
            { id: SALES, kind: 'channel', label: '#sales', outside: false },
            { id: DM, kind: 'dm', label: 'Drew Lin', outside: true },
          ],
        })
      }
      if (url === '/api/account/email/shares' && method === 'POST') return respond(201, { share: { id: SHARE }, label: '#sales', message: { id: 'msg-1' } })
      if (url === `/api/account/email/shares/${SHARE}` && method === 'DELETE') return respond(200, { ok: true })
      if (url === '/api/account/team-chat/messages/msg-1' && method === 'DELETE') return respond(200, { ok: true })
      return respond(404, {})
    }
  })

  it('lists channels and DMs, warns where guests read, and shares with the note; Undo deletes its message (which un-shares)', async () => {
    const onShared = vi.fn()
    const onUndone = vi.fn()
    const onOpenChange = vi.fn()
    await render(h(EmailShareDialog, { open: true, onOpenChange, thread: { threadId: 'thr-1', accountId: 'acc-1' }, onShared, onUndone }))
    expect($(`[data-share-target="${SALES}"]`)).not.toBeNull()
    expect($(`[data-share-target="${DM}"]`)).not.toBeNull()

    // A DM with a guest: one warning line.
    await act(async () => $<HTMLButtonElement>(`[data-share-target="${DM}"]`)!.click())
    expect($('[data-share-outside-warning]')?.textContent).toContain('People outside the workspace are in this channel')
    await act(async () => $<HTMLButtonElement>(`[data-share-target="${SALES}"]`)!.click())
    expect($('[data-share-outside-warning]')).toBeNull()

    await act(async () => setValue($<HTMLTextAreaElement>('textarea[aria-label="Note"]')!, 'Can someone check the discount?'))
    await act(async () => $<HTMLButtonElement>('[data-share-submit]')!.click())
    await flush()
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ threadId: 'thr-1', accountId: 'acc-1', channelId: SALES, note: 'Can someone check the discount?' })
    expect(onShared).toHaveBeenCalledWith(SHARE)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(toasts.success).toHaveBeenCalledWith('Shared to #sales', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }))

    const undo = toasts.success.mock.calls[0][1].action.onClick as () => void
    await act(async () => undo())
    await flush()
    // The message goes (the trigger revokes the share): no "No longer shared" stub left in the channel.
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/account/team-chat/messages/msg-1'])
    expect(onUndone).toHaveBeenCalled()
  })

  it('Undo falls back to un-sharing when the message can’t be deleted', async () => {
    const base = routes
    routes = (url, method) => (url.startsWith('/api/account/team-chat/messages/') ? respond(500, {}) : base(url, method))
    await render(h(EmailShareDialog, { open: true, onOpenChange: vi.fn(), thread: { threadId: 'thr-1' } }))
    await act(async () => $<HTMLButtonElement>(`[data-share-target="${SALES}"]`)!.click())
    await act(async () => $<HTMLButtonElement>('[data-share-submit]')!.click())
    await flush()
    await act(async () => (toasts.success.mock.calls[0][1].action.onClick as () => void)())
    await flush()
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/account/team-chat/messages/msg-1', `/api/account/email/shares/${SHARE}`])
  })

  it('a refused share says why and keeps the dialog open', async () => {
    routes = (url, method) =>
      url.endsWith('/targets') ? respond(200, { targets: [{ id: SALES, kind: 'channel', label: '#sales', outside: false }] }) : method === 'POST' ? respond(403, { error: "You can't post there" }) : respond(404, {})
    const onOpenChange = vi.fn()
    await render(h(EmailShareDialog, { open: true, onOpenChange, thread: { indexId: 'idx-1' } }))
    await act(async () => $<HTMLButtonElement>(`[data-share-target="${SALES}"]`)!.click())
    await act(async () => $<HTMLButtonElement>('[data-share-submit]')!.click())
    await flush()
    expect(toasts.error).toHaveBeenCalledWith("You can't post there")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

describe('the owner’s chips', () => {
  it('one chip per share, "Shared to #sales · Un-share"; Un-share ends it', async () => {
    routes = (url, method) => {
      if (url.startsWith('/api/account/email/shares?') && method === 'GET') {
        return respond(200, { shares: [{ id: SHARE, channelId: SALES, label: '#sales', createdAt: '2026-11-14T10:00:00Z' }] })
      }
      if (method === 'DELETE') return respond(200, { ok: true })
      return respond(404, {})
    }
    await render(h(EmailShareChips, { thread: { threadId: 'thr-1', accountId: 'acc-1' } }))
    expect(calls[0].url).toBe('/api/account/email/shares?thread=thr-1&account=acc-1')
    expect($(`[data-email-share-chip="${SHARE}"]`)?.textContent).toBe('Shared to #sales·Un-share')
    await act(async () => $<HTMLButtonElement>(`[data-email-unshare="${SHARE}"]`)!.click())
    await flush()
    expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/account/email/shares/${SHARE}`)).toBe(true)
    expect($(`[data-email-share-chip="${SHARE}"]`)).toBeNull()
    expect(toasts.success).toHaveBeenCalledWith('Un-shared from #sales')
  })

  it('nothing shared (or not the owner): nothing drawn', async () => {
    routes = () => respond(200, { shares: [] })
    await render(h(EmailShareChips, { thread: { threadId: 'thr-1' } }))
    expect($('[data-email-share-chip]')).toBeNull()
  })
})

describe('the thread view', () => {
  it('offers Share to chat and shows where it is shared', async () => {
    const thread = {
      threadId: 'thr-1',
      indexId: 'idx-1',
      subject: 'Northwind renewal terms',
      messages: [
        {
          id: 'm-1',
          threadId: 'thr-1',
          from: { name: 'Dana Whitfield', email: 'dana@harborline.example' },
          to: [],
          cc: [],
          subject: 'Northwind renewal terms',
          date: '2026-11-10T15:00:00Z',
          bodyHtml: null,
          bodyText: 'Our counter is 12% off list.',
          isUnread: false,
          isStarred: false,
          isDraft: false,
          hasAttachments: false,
          attachments: [],
        },
      ],
      drafts: [],
      contact: null,
      metadata: { needs_reply: false, auto_classified: null, linked_capture_id: null },
    }
    routes = (url) => {
      if (url.startsWith('/api/account/email/shares?')) return respond(200, { shares: [{ id: SHARE, channelId: SALES, label: '#sales', createdAt: '2026-11-14T10:00:00Z' }] })
      if (url.endsWith('/labels')) return respond(200, { labels: [] })
      if (url.startsWith('/api/account/email/shares/targets')) return respond(200, { targets: [] })
      if (url.startsWith('/api/account/email/scheduled')) return respond(200, { scheduled: [] })
      return respond(200, thread)
    }
    await render(h(EmailThreadDetail, { threadId: 'thr-1' } as never))
    expect($('button[data-email-share]')).not.toBeNull()
    expect($(`[data-email-share-chip="${SHARE}"]`)?.textContent).toContain('Shared to #sales')
    await act(async () => $<HTMLButtonElement>('button[data-email-share]')!.click())
    await flush()
    expect($('[data-email-share-dialog]')).not.toBeNull()
  })
})

describe('the card in team chat', () => {
  const live = { id: SHARE, state: 'live', mine: false, sender: 'dana@harborline.example', subject: 'Northwind renewal terms', firstLine: 'Our counter is 12% off list.', messageCount: 2 }
  const thread = {
    id: SHARE,
    subject: 'Northwind renewal terms',
    mine: false,
    missing: 1,
    blockedImages: 0,
    messages: [
      {
        id: 'm-1',
        from: { name: 'Dana Whitfield', email: 'dana@harborline.example' },
        to: [{ name: null, email: 'avery@northwind.example' }],
        cc: [],
        date: '2026-11-10T15:00:00Z',
        subject: 'Northwind renewal terms',
        bodyHtml: null,
        bodyText: 'Our counter is 12% off list.',
        attachments: [{ key: '2', name: 'terms.pdf', size: 1200, mimeType: 'application/pdf' }],
      },
    ],
  }

  it('loads live: sender, subject, first line; Open shows the thread read-only, files through the share', async () => {
    routes = (url) => (url.endsWith('?view=card') ? respond(200, live) : url === `/api/account/email/shares/${SHARE}` ? respond(200, thread) : respond(404, {}))
    await render(h(EmailShareCard, { shareId: SHARE }))
    const card = $(`[data-email-share-card="${SHARE}"]`)!
    expect(card.getAttribute('data-state')).toBe('live')
    expect(card.textContent).toContain('dana@harborline.example')
    expect(card.textContent).toContain('Northwind renewal terms')
    expect(card.textContent).toContain('Our counter is 12% off list.')
    expect(card.textContent).toContain('2 messages')
    expect(card.className).toContain('ph-no-capture')
    // Not the owner: no menu.
    expect($('[data-email-share-menu]')).toBeNull()

    await act(async () => $<HTMLButtonElement>('[data-email-share-open]')!.click())
    await flush()
    const dialog = $('[data-email-share-thread]')!
    expect(dialog.textContent).toContain('1 message is no longer available.')
    const link = $<HTMLAnchorElement>('[data-email-attachment-link]')!
    expect(link.getAttribute('href')).toBe(`/api/account/email/shares/${SHARE}/attachment?message=m-1&key=2`)
    // Read-only: no reply, send or forward.
    expect(dialog.querySelector('[title="Reply with AI"]')).toBeNull()
    expect(dialog.textContent).not.toMatch(/Reply|Forward|Send/)
  })

  it('remote images: "Load images" reads it again with them', async () => {
    routes = (url) =>
      url.endsWith('?view=card')
        ? respond(200, live)
        : url === `/api/account/email/shares/${SHARE}`
          ? respond(200, { ...thread, blockedImages: 2 })
          : url === `/api/account/email/shares/${SHARE}?images=1`
            ? respond(200, { ...thread, blockedImages: 0 })
            : respond(404, {})
    await render(h(EmailShareCard, { shareId: SHARE }))
    await act(async () => $<HTMLButtonElement>('[data-email-share-open]')!.click())
    await flush()
    expect($('[data-email-share-images]')?.textContent).toContain('Images from outside were not loaded.')
    await act(async () => $<HTMLButtonElement>('[data-email-share-load-images]')!.click())
    await flush()
    expect(calls.map((c) => c.url)).toContain(`/api/account/email/shares/${SHARE}?images=1`)
    expect($('[data-email-share-images]')).toBeNull()
  })

  it('a busy mailbox: "Couldn’t load right now · Retry" on the card and in the thread, never "no longer available"', async () => {
    let up = false
    routes = (url) => {
      if (!up) return respond(503, { error: 'Couldn’t load right now', code: 'busy' })
      return url.endsWith('?view=card') ? respond(200, live) : respond(200, thread)
    }
    await render(h(EmailShareCard, { shareId: SHARE }))
    expect($('[data-email-share-busy]')?.textContent).toContain('Couldn’t load right now')
    expect(text()).not.toContain('no longer available')
    up = true
    await act(async () => $<HTMLButtonElement>('[data-email-share-retry]')!.click())
    await flush()
    expect($(`[data-email-share-card="${SHARE}"]`)!.getAttribute('data-state')).toBe('live')

    up = false
    await act(async () => $<HTMLButtonElement>('[data-email-share-open]')!.click())
    await flush()
    const dialog = $('[data-email-share-thread]')!
    expect(dialog.querySelector('[data-email-share-busy]')).not.toBeNull()
    expect(dialog.textContent).not.toContain('no longer available')
    up = true
    await act(async () => dialog.querySelector<HTMLButtonElement>('[data-email-share-retry]')!.click())
    await flush()
    expect($('[data-email-share-thread]')!.textContent).toContain('Our counter is 12% off list.')
  })

  it('the owner gets a menu to un-share', async () => {
    routes = () => respond(200, { ...live, mine: true })
    await render(h(EmailShareCard, { shareId: SHARE }))
    expect($('[data-email-share-menu]')).not.toBeNull()
  })

  it('revoked: "No longer shared"; unavailable: "This email is no longer available"', async () => {
    routes = () => respond(200, { ...live, state: 'revoked', sender: null, subject: null, firstLine: null })
    await render(h(EmailShareCard, { shareId: SHARE }))
    expect($('[data-email-share-revoked]')?.textContent).toBe('No longer shared')
    expect($('[data-email-share-open]')).toBeNull()

    await act(async () => root.unmount())
    root = createRoot(container)
    routes = () => respond(200, { ...live, state: 'unavailable', sender: null, subject: null, firstLine: null })
    await render(h(EmailShareCard, { shareId: SHARE }))
    expect($('[data-email-share-unavailable]')?.textContent).toBe('This email is no longer available')
  })

  it('a reader who may not see it gets nothing of it', async () => {
    routes = () => respond(404, { error: 'Not found' })
    await render(h(EmailShareCard, { shareId: SHARE }))
    expect(text()).toContain('This email is no longer available')
    expect($('[data-email-share-open]')).toBeNull()
  })
})
