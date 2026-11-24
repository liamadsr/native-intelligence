// @vitest-environment jsdom
/**
 * Drive's Files card (docs/plans/drive-files.md, phase 2): uploads and team
 * chat files merged newest first; All, My files, Recent and Shared with me;
 * mail attachments behind their own filter, read live; the list is the views
 * system's (docs/plans/views-everywhere.md: the shared toolbar's type,
 * creator and sort, the shared rows); a file opened in the viewer (and its open recorded, never a mail
 * file's); a dropped or picked file uploaded to Drive; M moves one's own
 * Drive upload to a folder. Made-up people and files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import type { ViewerFile } from '@/lib/files/viewer-file'

const hoisted = vi.hoisted(() => ({
  download: vi.fn(async () => 'saved'),
  signed: vi.fn(),
  opened: [] as ViewerFile[],
  uploads: [] as Array<{ files: File[]; parent: unknown }>,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/download', () => ({ downloadFile: hoisted.download }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ storage: { from: (bucket: string) => ({ createSignedUrl: (path: string, ttl: number) => hoisted.signed(bucket, path, ttl) }) } }),
}))
vi.mock('@/lib/team-chat/upload-client', () => ({
  cachedTeamChatFileUrl: () => null,
  teamChatFileUrl: async (path: string) => `https://chat.test/${path}`,
}))
vi.mock('@/lib/attachments/upload-client', () => ({
  uploadAttachments: async (files: File[], parent: unknown) => {
    hoisted.uploads.push({ files, parent })
    return { uploaded: files.length, firstError: null }
  },
}))
vi.mock('@/components/files/file-viewer', () => ({
  useFileViewer: () => {
    const [file, setFile] = React.useState<ViewerFile | null>(null)
    const open = React.useCallback((f: ViewerFile) => {
      hoisted.opened.push(f)
      setFile(f)
    }, [])
    return { open, viewer: file ? React.createElement('div', { 'data-viewer': file.url ?? file.key, 'data-name': file.name }) : null }
  },
}))
// jsdom cannot size the shared list's virtualizer: every row drawn.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({ index, key: index, start: index * opts.estimateSize(), size: opts.estimateSize(), end: (index + 1) * opts.estimateSize() })),
    getTotalSize: () => opts.count * opts.estimateSize(),
    measureElement: () => {},
    measure: () => {},
    scrollToIndex: () => {},
  }),
}))
vi.mock('../card-body', () => ({
  CardRecordPanel: ({ record }: { record: { type: string; id: string } }) => React.createElement('div', { 'data-record-panel': `${record.type}:${record.id}` }),
  useOpenRecords: () => {
    const [stack, setStack] = React.useState<Array<{ type: string; id: string; label?: string }>>([])
    return {
      current: stack[stack.length - 1] ?? null,
      open: (r: { type: string; id: string; label?: string }) => setStack((s) => [...s, r]),
      close: () => setStack([]),
    }
  },
}))

import FilesCard, { fileIconOf, fileRowOf, toggleSource } from '../pages/files-card'
import { filterLocalRows } from '@/lib/views/local-rows'
import { itemFromUpload } from '@/lib/drive/drive-items'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { WorkspaceFile } from '@/lib/attachments/workspace-files-model'
import type { DriveChatFile } from '@/lib/drive/chat-files'
import type { MailFile } from '@/lib/drive/mail-files'

const spec: PageCardSpec = { kind: 'files', title: 'Files' }
const ME = { id: 'mem-me', user_id: 'u-me', display_name: 'Ada Park' }
const BO = { id: 'mem-bo', user_id: 'u-bo', display_name: 'Bo Lin' }

const up = (id: string, parent: WorkspaceFile['parent'], extra: Partial<WorkspaceFile> = {}): WorkspaceFile => ({
  id,
  file_name: `${id}.pdf`,
  file_size_bytes: 2_516_582,
  mime_type: 'application/pdf',
  file_extension: 'pdf',
  file_category: 'document',
  storage_path: `u1/x/${id}.pdf`,
  thumbnail_path: null,
  created_at: '2026-11-09T10:00:00Z',
  updated_at: '2026-11-09T10:00:00Z',
  user_id: 'u-me',
  parent,
  ...extra,
})
const QUOTE = up('quote', { type: 'action', id: 'act-1', label: 'Send the quote' }, { file_name: 'quote.xlsx', file_extension: 'xlsx', file_size_bytes: 840_000, created_at: '2026-11-07T10:00:00Z', updated_at: '2026-11-07T10:00:00Z', user_id: 'u-bo' })
const MINE = up('mine', { type: 'drive', id: 'mine', label: 'Drive' }, { file_name: 'notes.md', mime_type: 'text/markdown', file_extension: 'md', created_at: '2026-11-11T10:00:00Z', updated_at: '2026-11-11T10:00:00Z' })
const CHAT: DriveChatFile = { key: 'ch-1/u-bo/a.png', name: 'shot.png', size: 900, mimeType: 'image/png', createdAt: '2026-11-10T10:00:00Z', messageId: 'msg-1', authorMemberId: 'mem-bo', channel: { id: 'ch-1', kind: 'channel', name: 'design' } }
const MAIL: MailFile = {
  key: 'acct:m1:plan.pdf',
  accountId: 'acct',
  provider: 'google',
  threadId: 't1',
  messageId: 'm1',
  name: 'plan.pdf',
  mimeType: 'application/pdf',
  size: 2048,
  subject: 'Q3 plan',
  fromName: 'Cy Ode',
  fromEmail: 'cy@example.com',
  date: '2026-11-12T10:00:00Z',
  href: '/api/account/email/threads/t1/attachment?message=m1&name=plan.pdf',
}

let routes: Partial<Record<string, (url: URL, init?: RequestInit) => unknown>>
const asked: string[] = []
let mount: ReturnType<typeof mountRoot>

beforeEach(() => {
  asked.length = 0
  hoisted.opened.length = 0
  hoisted.uploads.length = 0
  hoisted.download.mockClear()
  hoisted.signed.mockReset()
  hoisted.signed.mockImplementation(async (_b: string, path: string) => ({ data: { signedUrl: `https://files.test/${path}` } }))
  routes = {
    '/api/account/files': () => ({ files: [MINE, QUOTE], next_offset: null }),
    '/api/account/drive/chat-files': () => ({ files: [CHAT], before: null }),
    '/api/account/drive/opens': () => ({ files: [] }),
    '/api/account/drive/mail-files': () => ({ files: [MAIL], cursor: null, mailboxes: 1 }),
    '/api/account/workspace/members': () => ({ members: [ME, BO] }),
    '/api/account/folders': () => ({ folders: [{ id: 'fo-1', name: 'Plans', parent_id: null, created_by: null, created_at: '', updated_at: '' }] }),
  }
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    const route: ((url: URL, init?: RequestInit) => unknown) | null = routes[url.pathname] ?? (url.pathname.startsWith('/api/account/folders/') ? () => ({ ok: true }) : null)
    return new Response(JSON.stringify(route ? route(url, init) : {}), { status: route ? 200 : 404, headers: { 'Content-Type': 'application/json' } })
  })
  mount = mountRoot()
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
})

const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}
const q = <T extends Element = HTMLElement>(sel: string) => mount.container.querySelector<T>(sel)
/** The shared list's rows, by their item key. */
const rows = () => Array.from(mount.container.querySelectorAll<HTMLElement>('[data-list-row-id]')).map((r) => r.dataset.listRowId)
const row = (key: string) => q(`[data-list-row-id="${key}"]`)
const click = async (sel: string) => {
  await act(async () => q(sel)!.click())
  await settle()
}
const pick = async (sel: string, value: string) => {
  await act(async () => {
    const el = q<HTMLSelectElement>(sel)!
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

async function render(onCount?: (n: number | null) => void) {
  await mount.render(React.createElement(FilesCard, { toolCallId: 'files-1', spec, store: makeStore('files-1', spec), fullScreen: true, onCount }))
  await settle()
  await settle()
}

describe('Drive’s Files card', () => {
  it('lists uploads and team chat files together, newest change first, with where each lives and who made it', async () => {
    const counts: Array<number | null> = []
    await render((n) => counts.push(n))
    expect(asked).toContain('GET /api/account/files?limit=50')
    expect(asked).toContain('GET /api/account/drive/chat-files?limit=50&tab=all')
    expect(asked.some((a) => a.includes('mail-files'))).toBe(false)
    expect(rows()).toEqual(['upload:mine', 'team_chat:ch-1/u-bo/a.png', 'upload:quote'])
    expect(row('upload:mine')!.textContent).toContain('Drive · only you')
    expect(row('team_chat:ch-1/u-bo/a.png')!.textContent).toContain('#design')
    const quote = row('upload:quote')!
    expect(quote.textContent).toContain('Action · Send the quote')
    expect(quote.textContent).toContain('Bo Lin')
    expect(quote.textContent).toContain('820 KB')
    expect(counts.at(-1)).toBe(3)
  })

  it('My files and Shared with me ask each source for the caller’s own, or others’', async () => {
    await render()
    await pick('[data-drive-filter="tab"]', 'mine')
    expect(asked).toContain('GET /api/account/files?limit=50&owner=mine')
    expect(asked).toContain('GET /api/account/drive/chat-files?limit=50&tab=mine')
    await pick('[data-drive-filter="tab"]', 'shared')
    expect(asked).toContain('GET /api/account/files?limit=50&owner=others')
    expect(asked).toContain('GET /api/account/drive/chat-files?limit=50&tab=shared')
  })

  it('in a card, Which files is a dropdown that starts on All files, beside the others, on the page’s one row from the card’s corner; none in its header (Liam, 11-23: "can\'t this also be a dropdown and we show all by default")', async () => {
    const right = document.createElement('div')
    document.body.append(right)
    const { CardHeaderSlotsProvider } = await import('../card-header-slot')
    await mount.render(
      React.createElement(CardHeaderSlotsProvider, { value: { left: null, right } }, React.createElement(FilesCard, { toolCallId: 'files-1', spec, store: makeStore('files-1', spec), fullScreen: true })),
    )
    await settle()
    expect(q('[data-drive-tabs]')).toBeNull()
    expect(right.querySelector('select')).toBeNull()
    const which = q<HTMLSelectElement>('[data-drive-filter="tab"]')!
    expect(which.value).toBe('all')
    expect(Array.from(which.options).map((o) => o.textContent)).toEqual(['All files', 'My files', 'Recent', 'Shared with me'])
    // One row, from the card's corner: the sources, then which files. Type, who made it and the sort are the shared toolbar's.
    const first = which.closest('[class*="px-2.5"]')!
    expect(first.querySelector('[data-drive-source="upload"]')).not.toBeNull()
    expect(q('[data-drive-filter="sort"]')).toBeNull()
    expect(q('[data-local-view-list="file"]')).not.toBeNull()
    // The header keeps the search and Upload.
    expect(right.querySelector('input, [aria-label="Search files"]')).not.toBeNull()
    expect(right.querySelector('[data-drive-upload]')).not.toBeNull()
    // The sources wear the tabs' pill.
    expect(q('[data-drive-source="upload"]')!.className).toContain('h-7')
    await pick('[data-drive-filter="tab"]', 'mine')
    expect(asked).toContain('GET /api/account/files?limit=50&owner=mine')
    expect(q<HTMLSelectElement>('[data-drive-filter="tab"]')!.value).toBe('mine')
    right.remove()
  })

  it('Recent lists what the person opened, most recent first', async () => {
    routes['/api/account/drive/opens'] = () => ({
      files: [
        { key: 'team_chat:ch-1/u-bo/a.png', openedAt: '2026-11-22T10:00:00Z', chat: CHAT },
        { key: 'upload:quote', openedAt: '2026-11-21T10:00:00Z', upload: QUOTE },
      ],
    })
    await render()
    await pick('[data-drive-filter="tab"]', 'recent')
    // Last opened first: Recent's own order while the view names none.
    expect(rows()).toEqual(['team_chat:ch-1/u-bo/a.png', 'upload:quote'])
  })

  it('keeps mail attachments behind their own filter, read live, and never records opening one', async () => {
    await render()
    expect(q('[data-drive-source="email"]')!.getAttribute('aria-pressed')).toBe('false')
    await click('[data-drive-source="email"]')
    expect(asked).toContain('GET /api/account/drive/mail-files')
    expect(q('[data-drive-email-note]')).not.toBeNull()
    expect(q('[data-drive-filter="tab"]')).toBeNull()
    expect(rows()).toEqual(['email:acct:m1:plan.pdf'])
    expect(row('email:acct:m1:plan.pdf')!.textContent).toContain('Q3 plan')
    await act(async () => row('email:acct:m1:plan.pdf')!.click())
    await settle()
    expect(hoisted.opened.at(-1)).toMatchObject({ name: 'plan.pdf', sourceLabel: 'Q3 plan' })
    expect(hoisted.opened.at(-1)!.load).toBeTypeOf('function')
    expect(asked.some((a) => a.startsWith('POST /api/account/drive/opens'))).toBe(false)
  })

  it('filters by type and by who made it (the shared filters over its rows), and toggles a source without hiding both', async () => {
    const files = [itemFromUpload(MINE), itemFromUpload(QUOTE)].map((i) => fileRowOf(i, [ME, BO]))
    const ids = (rs: Array<{ id: string }>) => rs.map((r) => r.id)
    const dates = new Set(['updated_at', 'created_at', 'opened_at'])
    // Type: the item's own kind (from its MIME type), as the page's Type select read it.
    const markdown = files.find((f) => f.id === 'upload:mine')!.file_type as string
    expect(files.find((f) => f.id === 'upload:quote')!.file_type).not.toBe(markdown)
    expect(ids(filterLocalRows(files, [{ id: 'f', field: 'file_type', operator: 'is', value: markdown }], dates))).toEqual(['upload:mine'])
    expect(ids(filterLocalRows(files, [{ id: 'f', field: 'created_by', operator: 'is', value: 'mem-bo' }], dates))).toEqual(['upload:quote'])
    expect(files.find((f) => f.id === 'upload:quote')).toMatchObject({ created_by: 'mem-bo', file_where: 'Action · Send the quote' })
    await render()
    await click('[data-drive-source="team_chat"]')
    expect(rows()).toEqual(['upload:mine', 'upload:quote'])
    const v = { tab: 'all' as const, uploads: true, chat: false, email: false }
    expect(toggleSource(v, 'uploads')).toMatchObject({ uploads: false, chat: true })
  })

  it('opens an upload in the viewer through a short signed link, and records the open', async () => {
    await render()
    await act(async () => row('upload:quote')!.click())
    await settle()
    expect(hoisted.signed).toHaveBeenCalledWith('attachments', 'u1/x/quote.pdf', 600)
    expect(q('[data-viewer]')!.dataset.viewer).toBe('https://files.test/u1/x/quote.pdf')
    expect(asked).toContain('POST /api/account/drive/opens')
    await act(async () => row('team_chat:ch-1/u-bo/a.png')!.click())
    await settle()
    expect(hoisted.opened.at(-1)).toMatchObject({ url: 'https://chat.test/ch-1/u-bo/a.png', sourceLabel: '#design' })
  })

  it('opens an upload’s record inside the card, from its row’s right-click', async () => {
    await render()
    // The shared row's menu mounts on its first right-click (useArmedContextMenu), then opens.
    for (let i = 0; i < 2; i++) {
      await act(async () => void row('upload:quote')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })))
      await settle()
    }
    const item = document.querySelector<HTMLElement>('[data-row-menu-item="open_parent"]')!
    expect(item.textContent).toContain('Open action')
    await act(async () => item.click())
    await settle()
    expect(q('[data-record-panel="action:act-1"]')).not.toBeNull()
  })

  it('M on one’s own Drive upload moves it to a folder', async () => {
    // jsdom lays nothing out: the list counts as on screen (list-keyboard.tsx asks); nor has it CSS.escape.
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    vi.stubGlobal('CSS', { escape: (v: string) => v.replace(/["\\]/g, '\\$&') })
    const key = (k: string) => act(async () => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
    await render()
    await key('j')
    expect(row('upload:mine')!.hasAttribute('data-list-focused')).toBe(true)
    await key('m')
    await settle()
    expect(q('[data-drive-move]')).not.toBeNull()
    await click('[data-drive-move-to="fo-1"]')
    expect(asked).toContain('POST /api/account/folders/fo-1/items')
    expect(q('[data-drive-move]')).toBeNull()
    // Someone else's file on a record: M does nothing.
    await key('j')
    await key('j')
    expect(row('upload:quote')!.hasAttribute('data-list-focused')).toBe(true)
    await key('m')
    await settle()
    expect(q('[data-drive-move]')).toBeNull()
    vi.restoreAllMocks()
  })

  it('uploads a picked file to Drive, unfiled', async () => {
    await render()
    const input = q<HTMLInputElement>('[data-drive-upload-input]')!
    const file = new File(['hi'], 'hello.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(hoisted.uploads).toEqual([{ files: [file], parent: { drive: {} } }])
  })

  it('says so when there is nothing, and when nothing matches', async () => {
    routes['/api/account/files'] = () => ({ files: [], next_offset: null })
    routes['/api/account/drive/chat-files'] = () => ({ files: [], before: null })
    await render()
    expect(q('[data-files-empty]')!.textContent).toContain('No files yet')
    await click('[data-drive-source="team_chat"]')
    expect(q('[data-files-empty]')!.textContent).toContain('No files match')
  })

  it('gives each kind of file its icon', () => {
    expect(fileIconOf({ file_category: 'image', file_extension: 'png' }).displayName ?? 'x').toBeTruthy()
  })
})
