// @vitest-environment jsdom
/**
 * The Files card (Liam, 11-11: "a new page that shows all available files
 * that were uploaded anywhere in the app, uploaded to captures or action
 * items or projects"): a row per file (its icon, name, record, size, date),
 * a category filter and a name search on GET /api/account/files, a record
 * opened inside the card, a file opened as a record's attachments open it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'

const hoisted = vi.hoisted(() => ({ download: vi.fn(async () => 'saved'), signed: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/download', () => ({ downloadFile: hoisted.download }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ storage: { from: (bucket: string) => ({ createSignedUrl: (path: string, ttl: number) => hoisted.signed(bucket, path, ttl) }) } }),
}))
vi.mock('@/components/capture/attachments-carousel', () => ({
  Lightbox: ({ images, signedUrls, onClose }: { images: Array<{ id: string; file_name: string }>; signedUrls: Record<string, string>; onClose: () => void }) =>
    React.createElement('div', { 'data-lightbox': signedUrls[images[0].id], 'data-name': images[0].file_name, onClick: onClose }),
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

import FilesCard, { FILES_EMPTY_PAGES_MAX, fileIconOf } from '../pages/files-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { WorkspaceFile } from '@/lib/attachments/workspace-files-model'

const spec: PageCardSpec = { kind: 'files', title: 'Files' }

const f = (id: string, parent: WorkspaceFile['parent'], extra: Partial<WorkspaceFile> = {}): WorkspaceFile => ({
  id,
  file_name: `${id}.pdf`,
  file_size_bytes: 2_516_582,
  mime_type: 'application/pdf',
  file_extension: 'pdf',
  file_category: 'document',
  storage_path: `u1/x/${id}.pdf`,
  thumbnail_path: null,
  created_at: '2026-11-09T10:00:00Z',
  parent,
  ...extra,
})
const QUOTE = f('quote', { type: 'action', id: 'act-1', label: 'Send the quote' }, { file_name: 'quote.xlsx', file_extension: 'xlsx', file_size_bytes: 840_000 })
const LOGO = f('logo', { type: 'project', id: 'proj-1', label: 'Website refresh' }, { file_name: 'logo.png', file_category: 'image', mime_type: 'image/png', file_extension: 'png', storage_path: 'u1/x/logo.png' })
const BRIEF = f('brief', { type: 'capture', id: 'cap-1', label: 'Kickoff with Fernhill' })

let pages: (url: URL) => { files: WorkspaceFile[]; next_offset: number | null }
const asked: string[] = []
let mount: ReturnType<typeof mountRoot>

beforeEach(() => {
  asked.length = 0
  hoisted.download.mockClear()
  hoisted.signed.mockReset()
  hoisted.signed.mockImplementation(async (_b: string, path: string) => ({ data: { signedUrl: `https://files.test/${path}` } }))
  pages = () => ({ files: [BRIEF, QUOTE, LOGO], next_offset: null })
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = new URL(String(input), 'http://localhost')
    asked.push(`${url.pathname}${url.search}`)
    return new Response(JSON.stringify(pages(url)), { status: 200, headers: { 'Content-Type': 'application/json' } })
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
const rowIds = () => Array.from(mount.container.querySelectorAll<HTMLElement>('[data-files-row]')).map((r) => r.dataset.filesRow)
const click = async (sel: string) => {
  await act(async () => q(sel)!.click())
  await settle()
}

async function render(onCount?: (n: number | null) => void) {
  await mount.render(React.createElement(FilesCard, { toolCallId: 'files-1', spec, store: makeStore('files-1', spec), fullScreen: true, onCount }))
  await settle()
}

describe('FilesCard', () => {
  it('lists every file, newest first: its icon, name, where it is attached, size and date', async () => {
    const counts: Array<number | null> = []
    await render((n) => counts.push(n))
    expect(asked).toEqual(['/api/account/files?limit=50'])
    expect(rowIds()).toEqual(['brief', 'quote', 'logo'])
    const quote = q('[data-files-row="quote"]')!
    expect(quote.querySelector('[data-files-open]')!.textContent).toBe('quote.xlsx')
    expect(quote.querySelector('[data-files-parent]')!.textContent).toBe('Action · Send the quote')
    expect(quote.textContent).toContain('820 KB')
    expect(quote.textContent).toContain('Nov 9')
    expect(quote.querySelector('svg.lucide-file-spreadsheet')).not.toBeNull()
    expect(q('[data-files-row="logo"] svg.lucide-file-image')).not.toBeNull()
    expect(q('[data-files-row="brief"]')!.textContent).toContain('2.4 MB')
    expect(q('[data-files-row="brief"] [data-files-parent]')!.textContent).toBe('Capture · Kickoff with Fernhill')
    // The header's count, once every page is in.
    expect(counts.at(-1)).toBe(3)
  })

  it('filters by category: All, Images, Documents', async () => {
    await render()
    expect(Array.from(mount.container.querySelectorAll<HTMLElement>('[data-files-filter]')).map((b) => b.textContent)).toEqual(['All', 'Images', 'Documents'])
    expect(q('[data-files-filter="all"]')!.getAttribute('aria-checked')).toBe('true')
    pages = (url) => ({ files: url.searchParams.get('category') === 'image' ? [LOGO] : [BRIEF, QUOTE, LOGO], next_offset: null })
    await click('[data-files-filter="image"]')
    expect(asked.at(-1)).toBe('/api/account/files?limit=50&category=image')
    expect(rowIds()).toEqual(['logo'])
    expect(q('[data-files-filter="image"]')!.getAttribute('aria-checked')).toBe('true')
    await click('[data-files-filter="all"]')
    expect(rowIds()).toEqual(['brief', 'quote', 'logo'])
  })

  it('searches the names', async () => {
    await render()
    pages = (url) => ({ files: url.searchParams.get('q') === 'quote' ? [QUOTE] : [], next_offset: null })
    const input = q<HTMLInputElement>('[data-files-search]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' quote ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(300)
    await settle()
    expect(asked.at(-1)).toBe('/api/account/files?limit=50&q=quote')
    expect(rowIds()).toEqual(['quote'])
  })

  it('opens the record a file is attached to inside the card, over the list', async () => {
    await render()
    await click('[data-files-row="brief"] [data-files-parent]')
    expect(q('[data-record-panel]')!.getAttribute('data-record-panel')).toBe('capture:cap-1')
    // The list under it is covered, still mounted.
    expect(q('[data-files-row="brief"]')!.closest('[inert]')).not.toBeNull()
  })

  it('opens an image in the attachments viewer and downloads any other file, through a short signed URL', async () => {
    await render()
    await click('[data-files-open="logo"]')
    expect(hoisted.signed).toHaveBeenCalledWith('attachments', 'u1/x/logo.png', 60)
    const viewer = document.querySelector<HTMLElement>('[data-lightbox]')!
    expect(viewer.dataset.lightbox).toBe('https://files.test/u1/x/logo.png')
    expect(viewer.dataset.name).toBe('logo.png')
    expect(hoisted.download).not.toHaveBeenCalled()
    // Escape closes it.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[data-lightbox]')).toBeNull()
    await click('[data-files-open="quote"]')
    expect(hoisted.download).toHaveBeenCalledWith('https://files.test/u1/x/quote.pdf', 'quote.xlsx')
    expect(document.querySelector('[data-lightbox]')).toBeNull()
  })

  it('pages on: Show more reads the next page and adds it', async () => {
    const counts: Array<number | null> = []
    pages = (url) => (url.searchParams.get('offset') === '50' ? { files: [LOGO], next_offset: null } : { files: [BRIEF, QUOTE], next_offset: 50 })
    await render((n) => counts.push(n))
    expect(rowIds()).toEqual(['brief', 'quote'])
    expect(counts.at(-1)).toBeNull()
    await click('[data-files-more]')
    expect(asked.at(-1)).toBe('/api/account/files?limit=50&offset=50')
    expect(rowIds()).toEqual(['brief', 'quote', 'logo'])
    expect(q('[data-files-more]')).toBeNull()
    expect(counts.at(-1)).toBe(3)
  })

  it('reads past a page the server emptied (its files on records the person can’t read) at once; "No files yet" only with nothing more', async () => {
    const counts: Array<number | null> = []
    // Offsets 0 and 50 dropped whole; 100 has a file and nothing after it.
    pages = (url) => {
      const offset = Number(url.searchParams.get('offset') ?? 0)
      return offset < 100 ? { files: [], next_offset: offset + 50 } : { files: [LOGO], next_offset: null }
    }
    await render((n) => counts.push(n))
    expect(asked).toEqual(['/api/account/files?limit=50', '/api/account/files?limit=50&offset=50', '/api/account/files?limit=50&offset=100'])
    expect(rowIds()).toEqual(['logo'])
    expect(q('[data-files-empty]')).toBeNull()
    expect(q('[data-files-more]')).toBeNull()
    expect(counts.at(-1)).toBe(1)
    // Every page empty to the end: truly none.
    asked.length = 0
    pages = (url) => {
      const offset = Number(url.searchParams.get('offset') ?? 0)
      return { files: [], next_offset: offset < 100 ? offset + 50 : null }
    }
    await click('[data-files-filter="image"]')
    expect(asked).toHaveLength(3)
    expect(q('[data-files-empty]')!.textContent).toContain('No files match')
  })

  it('reads at most FILES_EMPTY_PAGES_MAX empty pages on its own; past them, "Show more", never "No files yet"', async () => {
    pages = (url) => ({ files: [], next_offset: Number(url.searchParams.get('offset') ?? 0) + 50 })
    await render()
    expect(asked).toHaveLength(FILES_EMPTY_PAGES_MAX)
    expect(q('[data-files-empty]')).toBeNull()
    expect(q('[data-files-more]')).not.toBeNull()
    pages = () => ({ files: [QUOTE], next_offset: null })
    await click('[data-files-more]')
    expect(asked.at(-1)).toBe(`/api/account/files?limit=50&offset=${50 * FILES_EMPTY_PAGES_MAX}`)
    expect(rowIds()).toEqual(['quote'])
  })

  it('says so when there are no files yet, and when none match', async () => {
    pages = () => ({ files: [], next_offset: null })
    await render()
    expect(q('[data-files-empty]')!.textContent).toContain('No files yet')
    await click('[data-files-filter="document"]')
    expect(q('[data-files-empty]')!.textContent).toContain('No files match')
  })

  it('gives each kind of file its icon', () => {
    const icon = (file_category: string, file_extension: string | null) => fileIconOf({ file_category, file_extension }).displayName
    expect([icon('image', 'png'), icon('document', 'csv'), icon('document', 'pdf'), icon('document', 'ts'), icon('document', null)]).toEqual([
      'FileImage',
      'FileSpreadsheet',
      'FileText',
      'FileCode',
      'File',
    ])
  })
})
