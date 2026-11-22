// @vitest-environment jsdom
/**
 * Comments — where the viewer's member id comes from.
 *
 * The component used to raw-fetch /api/account/workspace (the heaviest request
 * in the app) in a []-dep effect on EVERY mount, and it is mounted inside the
 * action/contact/project detail panels, which remount per next/back step. Two
 * behaviours are pinned:
 *
 *  - a supplied `currentMemberId` prop skips the workspace lookup entirely
 *    (all three detail panels supply it from the workspace-switcher context),
 *  - the fallback for prop-less callers goes through cachedJson with the
 *    workspace scope — shared SWR cache, not a fresh request per mount.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  cachedJson: vi.fn(),
}))

vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: vi.fn() }))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
  useWorkspaceEdition: () => null,
}))
vi.mock('@/lib/cached-fetch', () => ({ cachedJson: hoisted.cachedJson }))
// The box is the main chat's composer (ChatInput), real; only the desktop's voice is stubbed (no dictation here).
vi.mock('@/hooks/recording-context', () => ({ useRecordingStable: () => ({}), useOptionalRecordingStable: () => null }))
vi.mock('@/hooks/use-voice-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-voice-availability')>()),
  useVoiceAvailability: () => ({ hasVoice: false, visible: false, dictation: false, conversation: false, blocked: null, status: {} }),
}))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))

// UI primitives stubbed to structure — radix portals/popovers are not under
// test here. The dropdown renders its content inline so the author-only Edit
// affordance is observable without pointer choreography.
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children?: ReactNode }) => h('span', {}, children),
  AvatarFallback: ({ children }: { children?: ReactNode }) => h('span', {}, children),
  AvatarImage: () => null,
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) =>
    h('button', { type: 'button', ...props }, children),
}))
vi.mock('@/components/ui/dropdown-menu', async (importOriginal) => ({
  // The composer's own menus use the rest, unstubbed.
  ...(await importOriginal<typeof import('@/components/ui/dropdown-menu')>()),
  DropdownMenu: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => h('span', {}, children),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  DropdownMenuItem: ({ children, ...props }: { children?: ReactNode }) =>
    h('button', { type: 'button', ...props }, children),
}))
vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? h('div', {}, children) : null,
  AlertDialogAction: ({ children }: { children?: ReactNode }) => h('button', {}, children),
  AlertDialogCancel: ({ children }: { children?: ReactNode }) => h('button', {}, children),
  AlertDialogContent: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogDescription: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogFooter: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogHeader: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogTitle: ({ children }: { children?: ReactNode }) => h('div', {}, children),
}))

import { Comments } from '../comments'
import { toast } from 'sonner'

const COMMENTS = [
  {
    id: 'c-1',
    body: 'Looks good',
    author_id: 'm-1',
    author_name: 'Alice',
    author_avatar: null,
    parent_id: null,
    reply_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    edited_at: null,
  },
]

let fetchCalls: string[] = []
let posts: Array<{ body: string; parent_id?: string; mentions?: string[] }> = []
let patches: Array<{ url: string; body: Record<string, unknown> }> = []
/** How the next POSTs fail, in order (a refused save, a dropped connection); empty: they post. */
let postFailures: Array<'refused' | 'offline'> = []

function installFetch() {
  fetchCalls = []
  posts = []
  patches = []
  postFailures = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      fetchCalls.push(url)
      if (url === '/api/account/actions/act-1/comments' && init?.method === 'POST') {
        const failure = postFailures.shift()
        if (failure === 'offline') throw new TypeError('Failed to fetch')
        if (failure === 'refused') return { ok: false, status: 500, json: async () => ({ error: 'column comment.mentions does not exist' }) }
        posts.push(JSON.parse(String(init.body)))
        return { ok: true, status: 200, json: async () => ({}) }
      }
      if (url === '/api/account/actions/act-1/comments') {
        return { ok: true, status: 200, json: async () => ({ comments: COMMENTS }) }
      }
      if (url.startsWith('/api/account/comments/') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        patches.push({ url, body })
        return { ok: true, status: 200, json: async () => ({ comment: { id: 'c-1', body: body.body, author_id: 'm-1', author_name: 'Alice', author_avatar: null, parent_id: null, created_at: COMMENTS[0].created_at, edited_at: new Date().toISOString(), mentions: body.mentions ?? [], record_mentions: body.records ?? [] } }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }),
  )
}

let container: HTMLDivElement
let root: Root

async function mount(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(h(Comments, { commentableType: 'action', commentableId: 'act-1', ...props }))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  installFetch()
  // One cached read per URL: the viewer's member id, and the members `@` lists.
  hoisted.cachedJson.mockImplementation(async (url: string) =>
    url === '/api/account/workspace/members'
      ? { members: [{ id: 'm-1', display_name: 'Alice' }, { id: 'm-2', display_name: 'Rosa Lind' }, { id: 'm-3', display_name: 'Ben Ruiz' }] }
      : { currentMemberId: 'm-1' },
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const workspaceLookups = () => hoisted.cachedJson.mock.calls.filter(([url]) => url === '/api/account/workspace')

describe('Comments — current member id source', () => {
  it('skips the workspace lookup when currentMemberId is supplied', async () => {
    await mount({ currentMemberId: 'm-1' })

    expect(workspaceLookups()).toHaveLength(0)
    expect(fetchCalls).not.toContain('/api/account/workspace')
    // The supplied id actually flows: Alice's own comment offers Edit.
    expect(container.textContent).toContain('Looks good')
    expect(container.textContent).toContain('Edit')
  })

  it('a non-author viewer gets no Edit affordance', async () => {
    await mount({ currentMemberId: 'm-2' })

    expect(workspaceLookups()).toHaveLength(0)
    expect(container.textContent).toContain('Looks good')
    expect(container.textContent).not.toContain('Edit')
  })

  it('falls back to cachedJson with workspace scope when no prop is supplied', async () => {
    await mount({})

    expect(workspaceLookups()).toHaveLength(1)
    expect(hoisted.cachedJson).toHaveBeenCalledWith('/api/account/workspace', { scope: 'ws-1' })
    // Never a raw fetch of the workspace payload.
    expect(fetchCalls).not.toContain('/api/account/workspace')
    // The fetched id flows the same way the prop does.
    expect(container.textContent).toContain('Edit')
  })
})

/**
 * The box is the main chat's composer (ChatInput, as team chat uses it): the
 * one-row pill with "+", the field, the mic and send, not a textarea of its
 * own. Enter posts the comment, Shift+Enter is a new line, Reply makes the
 * next post a reply (and says so above the pill), and `@` lists the
 * teammates, never a record search: a comment is words only.
 */
describe('Comments — the box is the shared composer', () => {
  // A real width, as a detail panel has: jsdom's is 0, and the field hides its placeholder when too narrow.
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 480 })
  })
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  })
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const composer = () => container.querySelector('[data-comment-composer]') as HTMLElement
  const box = () => composer().querySelector('textarea') as HTMLTextAreaElement
  const send = () => composer().querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!
  async function settle() {
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
  }
  function type(text: string) {
    act(() => box().focus())
    for (const ch of text) {
      act(() => {
        const ta = box()
        const { selectionStart: s, selectionEnd: e, value } = ta
        setter.call(ta, value.slice(0, s) + ch + value.slice(e))
        ta.setSelectionRange(s + 1, s + 1)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
  }
  function press(key: string, opts: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
    act(() => {
      box().dispatchEvent(event)
    })
    return event
  }

  it('is the inline pill (+, the field, send) with the comment placeholder', async () => {
    await mount({ currentMemberId: 'm-1' })

    expect(composer().querySelector('[data-composer-layout="inline"]')).toBeTruthy()
    expect(box().getAttribute('placeholder')).toBe('Leave a comment…')
    expect(send()).toBeTruthy()
    // Nothing to send yet.
    expect(send().disabled).toBe(true)
  })

  it('Enter posts the comment and clears the box; Shift+Enter does not post', async () => {
    await mount({ currentMemberId: 'm-1' })

    type('First line')
    const shift = press('Enter', { shiftKey: true })
    expect(shift.defaultPrevented).toBe(false)
    await settle()
    expect(posts).toEqual([])

    expect(send().disabled).toBe(false)
    press('Enter')
    await settle()
    expect(posts).toEqual([{ body: 'First line' }])
    expect(box().value).toBe('')
  })

  it('a comment the server refuses, or a dropped connection, says so and keeps its words; the next send still posts', async () => {
    const toastError = vi.spyOn(toast, 'error').mockImplementation(() => '')
    await mount({ currentMemberId: 'm-1' })
    postFailures = ['refused', 'offline']

    type('Ship it')
    press('Enter')
    await settle()
    expect(posts).toEqual([])
    expect(toastError).toHaveBeenCalledWith('Your comment wasn’t posted. Try again.')
    expect(box().value).toBe('Ship it')

    // A dropped connection used to leave the box stuck: every later send was ignored.
    press('Enter')
    await settle()
    expect(toastError).toHaveBeenCalledTimes(2)
    expect(box().value).toBe('Ship it')

    press('Enter')
    await settle()
    expect(posts).toEqual([{ body: 'Ship it' }])
    expect(box().value).toBe('')
  })

  it('the send button posts too, and a blank box posts nothing', async () => {
    await mount({ currentMemberId: 'm-1' })

    type('   ')
    press('Enter')
    await settle()
    expect(posts).toEqual([])

    type('Ship it')
    act(() => send().click())
    await settle()
    expect(posts).toEqual([{ body: 'Ship it' }])
  })

  it('Reply: says whom it answers, posts with parent_id, and focuses the box', async () => {
    await mount({ currentMemberId: 'm-2' })

    const reply = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reply')!
    await act(async () => reply.click())
    await act(async () => new Promise((r) => requestAnimationFrame(() => r())))
    expect(composer().querySelector('[data-comment-replying]')?.textContent).toContain('Replying to Alice')
    expect(box().getAttribute('placeholder')).toBe('Reply to Alice…')
    expect(document.activeElement).toBe(box())

    type('Agreed')
    press('Enter')
    await settle()
    expect(posts).toEqual([{ body: 'Agreed', parent_id: 'c-1' }])
    expect(composer().querySelector('[data-comment-replying]')).toBeNull()
  })

  it('cancelling a reply posts a plain comment', async () => {
    await mount({ currentMemberId: 'm-2' })

    const reply = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reply')!
    await act(async () => reply.click())
    act(() => composer().querySelector<HTMLButtonElement>('button[aria-label="Cancel reply"]')!.click())

    type('Top level')
    press('Enter')
    await settle()
    expect(posts).toEqual([{ body: 'Top level' }])
  })

  it('@ lists the teammates but the viewer (no record search before a word is typed), and a pick goes in the words and with the comment', async () => {
    await mount({ currentMemberId: 'm-1' })

    type('@')
    await settle()
    const options = [...document.querySelectorAll('[data-mention-option]')].map((r) => r.getAttribute('data-mention-option'))
    expect(options).toEqual(['m-2', 'm-3'])
    expect(fetchCalls.some((u) => u.startsWith('/api/account/search'))).toBe(false)

    type('ro')
    await settle()
    press('Enter')
    await settle()
    expect(box().value).toBe('@Rosa Lind ')
    expect(posts).toEqual([])

    type('take a look?')
    press('Enter')
    await settle()
    // The teammate picked rides with the comment (their mention is stored, and they are told).
    expect(posts).toEqual([{ body: '@Rosa Lind take a look?', mentions: ['m-2'] }])
  })
})

/**
 * Editing a comment uses the same composer, prefilled with the body, so `@`
 * offers teammates and records there too, and Save PATCHes { body, mentions,
 * records } — what the edited words still name.
 */
describe('Comments — editing uses the composer with @', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 480 })
  })
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  })
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const editBox = () => container.querySelector('[data-comment-edit]') as HTMLElement | null
  const editField = () => editBox()!.querySelector('textarea') as HTMLTextAreaElement
  async function settle() {
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
  }
  function typeInto(ta: HTMLTextAreaElement, text: string) {
    act(() => ta.focus())
    for (const ch of text) {
      act(() => {
        const { selectionStart: s, selectionEnd: e, value } = ta
        setter.call(ta, value.slice(0, s) + ch + value.slice(e))
        ta.setSelectionRange(s + 1, s + 1)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
  }
  function pressOn(ta: HTMLTextAreaElement, key: string, opts: KeyboardEventInit = {}) {
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }))
    })
  }

  it('prefills the body, lists teammates on @, and saves the mention that stays in the words', async () => {
    await mount({ currentMemberId: 'm-1' })

    // Alice's own comment offers Edit (the dropdown renders inline in the stub).
    const edit = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Edit')!
    await act(async () => edit.click())
    await settle()

    expect(editBox()).toBeTruthy()
    const ta = editField()
    // Prefilled with the comment's body.
    expect(ta.value).toBe('Looks good')

    // Append a teammate mention: `@` lists the teammates (not the viewer).
    act(() => ta.setSelectionRange(ta.value.length, ta.value.length))
    typeInto(ta, ' @ro')
    await settle()
    const options = [...document.querySelectorAll('[data-mention-option]')].map((r) => r.getAttribute('data-mention-option'))
    expect(options).toEqual(['m-2'])
    pressOn(ta, 'Enter')
    await settle()
    expect(editField().value).toBe('Looks good @Rosa Lind ')

    // Save PATCHes the edited body with the mention it still names.
    const save = [...editBox()!.querySelectorAll('button')].find((b) => b.textContent === 'Save')!
    await act(async () => save.click())
    await settle()

    expect(patches).toHaveLength(1)
    expect(patches[0].url).toBe('/api/account/comments/c-1')
    expect(patches[0].body).toEqual({ body: 'Looks good @Rosa Lind', mentions: ['m-2'], records: [] })
    // The edit box closes after a save.
    expect(editBox()).toBeNull()
  })
})
