// @vitest-environment jsdom
/**
 * The Folders page as a card (Drive folders, migration 690): the top folders;
 * one folder's path, subfolders and records; New in the open folder ("Create
 * in <folder>"); Add files a record already made; a record opens as the app
 * opens it. fetch is stubbed with made-up folders and records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'

const { openTarget, openCard, openCreateDialog } = vi.hoisted(() => ({
  openTarget: vi.fn((..._a: unknown[]) => true),
  openCard: vi.fn((..._a: unknown[]) => true),
  openCreateDialog: vi.fn((..._a: unknown[]) => {}),
}))
vi.mock('@/lib/chat-cards/open-card', () => ({ openTarget, openCard }))
vi.mock('@/lib/create/open-create', () => ({ openCreateDialog }))

import { makeStore, mountRoot } from './page-card-harness'
import { CardHeaderSlotsProvider } from '../card-header-slot'
import { FoldersPageCard } from '../pages/folders-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const CLIENTS = '11111111-1111-4111-8111-111111111111'
const ACME = '22222222-2222-4222-8222-222222222222'
const DOC = '33333333-3333-4333-8333-333333333333'
const SHEET = '44444444-4444-4444-8444-444444444444'
const folders = [
  { id: CLIENTS, name: 'Clients', parent_id: null, created_by: 'm-1', created_at: '', updated_at: '' },
  { id: ACME, name: 'Acme Test Co', parent_id: CLIENTS, created_by: 'm-1', created_at: '', updated_at: '' },
]

const posts: Array<{ url: string; body: unknown }> = []
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method && init.method !== 'GET') {
    posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
    return new Response('{"ok":true}', { status: 200 })
  }
  if (url === '/api/account/folders') return new Response(JSON.stringify({ folders }))
  if (url === `/api/account/folders/${CLIENTS}`)
    return new Response(JSON.stringify({ folder: folders[0], items: [{ type: 'document', id: DOC, title: 'Kickoff notes', updated_at: null, filed_at: '' }] }))
  if (url.startsWith('/api/account/folders/candidates'))
    return new Response(JSON.stringify({ records: [{ type: 'spreadsheet', id: SHEET, title: 'Budget', updated_at: null }] }))
  return new Response('{}', { status: 404 })
})

let mount = mountRoot()
let right: HTMLDivElement
beforeEach(() => {
  mount = mountRoot()
  posts.length = 0
  vi.stubGlobal('fetch', fetchMock)
  right = document.createElement('div')
  document.body.appendChild(right)
})
afterEach(() => {
  mount.unmount()
  right.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

let n = 0
async function render(spec: PageCardSpec) {
  // A card of its own each time: a card's place is kept by its id.
  const id = `folders-${++n}`
  const store = makeStore(id, spec)
  await mount.render(
    React.createElement(
      CardHeaderSlotsProvider,
      { value: { left: null, right } },
      React.createElement(FoldersPageCard, { toolCallId: id, spec, store, fullScreen: false }),
    ),
  )
  await act(async () => void (await new Promise((r) => setTimeout(r, 0))))
  return store
}
const q = (sel: string) => mount.container.querySelector<HTMLElement>(sel) ?? right.querySelector<HTMLElement>(sel)
const click = (el: HTMLElement | null) => act(async () => void el!.click())
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 200))))

describe('the Folders card', () => {
  it('shows the top folders, and opens one in place', async () => {
    await render({ kind: 'folders', title: 'Folders' })
    expect(q(`[data-folder-row="${CLIENTS}"]`)!.textContent).toContain('Clients')
    expect(q(`[data-folder-row="${ACME}"]`)).toBeNull()
    expect(q('[data-folder-path]')).toBeNull()
    await click(q(`[data-folder-row="${CLIENTS}"] button`))
    await settle()
    expect(q('[data-folder-path]')!.textContent).toBe('FoldersClients')
    expect(q(`[data-folder-row="${ACME}"]`)!.textContent).toContain('Acme Test Co')
    expect(q(`[data-folder-item="document:${DOC}"]`)!.textContent).toContain('Kickoff notes')
  })

  it('opens a filed doc as the app opens a doc', async () => {
    await render({ kind: 'folders', title: 'Folders', target: { type: 'drive_folder', id: CLIENTS, label: 'Clients' } })
    await click(q(`[data-folder-item="document:${DOC}"] button`))
    expect(openTarget).toHaveBeenCalledWith({ type: 'document', id: DOC, title: 'Kickoff notes' }, { from: 'folders' })
  })

  it('New in a folder opens the composer “Create in <folder>”; at the top it makes only a folder', async () => {
    await render({ kind: 'folders', title: 'Folders' })
    await click(q('[data-folder-new]'))
    expect([...right.querySelectorAll('[data-folder-new-type]')].map((e) => e.getAttribute('data-folder-new-type'))).toEqual(['folder'])
    await click(q('[data-folder-new-type="folder"]'))
    expect(openCreateDialog).toHaveBeenLastCalledWith({ type: 'folder' })

    mount.unmount()
    mount = mountRoot()
    await render({ kind: 'folders', title: 'Folders', target: { type: 'drive_folder', id: CLIENTS, label: 'Clients' } })
    await click(q('[data-folder-new]'))
    await click(q('[data-folder-new-type="spreadsheet"]'))
    expect(openCreateDialog).toHaveBeenLastCalledWith({ type: 'spreadsheet', context: { container: { kind: 'folder', id: CLIENTS, name: 'Clients' } } })
  })

  it('Add files a record that sits in no folder', async () => {
    await render({ kind: 'folders', title: 'Folders', target: { type: 'drive_folder', id: CLIENTS, label: 'Clients' } })
    await click(q('[data-folder-add]'))
    await settle()
    await click(q(`[data-folder-candidate="spreadsheet:${SHEET}"]`))
    expect(posts).toEqual([{ url: `/api/account/folders/${CLIENTS}/items`, body: { type: 'spreadsheet', id: SHEET } }])
  })

  it('a folder that is gone says so, with the way back', async () => {
    await render({ kind: 'folders', title: 'Folders', target: { type: 'drive_folder', id: '55555555-5555-4555-8555-555555555555', label: 'Old' } })
    expect(mount.container.textContent).toContain('This folder is gone')
  })

  it('a list that can’t be read says so, not “no folders”', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{"error":"down"}', { status: 500 }))
    await render({ kind: 'folders', title: 'Folders' })
    expect(mount.container.textContent).toContain('couldn’t be loaded')
  })
})
