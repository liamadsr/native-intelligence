// @vitest-environment jsdom
/**
 * "People & channels with access" (entity-access-section.tsx), the section
 * slid into the document and capture Share dialog: it renders only for
 * someone who may share the record and only when there is something to say
 * (the record is private, or it has grants); it lists the grants by name,
 * removes one, adds one; list-only (the contact dialog) has no picker.
 * Driven through a real render (createRoot + act). Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { EntityAccessResponse } from '@/lib/entity-access/model'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { EntityAccessSection } from '../entity-access-section'

const GRANTS: EntityAccessResponse['grants'] = [
  { id: 'g-1', grantee_kind: 'member', grantee_id: 'm-rosa', grantee_name: 'Rosa Lind', source: 'manual', created_at: '2026-11-01T00:00:00Z' },
  { id: 'g-2', grantee_kind: 'channel', grantee_id: 'ch-launch', grantee_name: '#launch', source: 'mention', created_at: '2026-11-02T00:00:00Z' },
]

let root: Root
let container: HTMLDivElement
let calls: Array<{ url: string; method: string; body?: unknown }>

function stub(access: EntityAccessResponse) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.startsWith('/api/account/entity-access?')) return new Response(JSON.stringify(access), { status: 200 })
    if (url.startsWith('/api/account/workspace')) {
      return new Response(JSON.stringify({ currentMemberId: 'm-me', members: [{ id: 'm-me', display_name: 'Jordan Ellery' }, { id: 'm-sam', display_name: 'Sam Okafor' }] }), { status: 200 })
    }
    if (url.startsWith('/api/account/teams')) return new Response(JSON.stringify({ teams: [] }), { status: 200 })
    if (url.startsWith('/api/account/team-chat/channels')) return new Response(JSON.stringify({ channels: [] }), { status: 200 })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
}

async function render(access: EntityAccessResponse, listOnly = false) {
  await act(async () => {
    root.render(h(EntityAccessSection, { type: 'document', id: 'doc-1', listOnly, fetchImpl: stub(access) }))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  calls = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('EntityAccessSection', () => {
  it('renders nothing for someone who can’t share the record', async () => {
    await render({ can_share: false, restricted: true, grants: GRANTS })
    expect(container.innerHTML).toBe('')
    // And reads nothing more than the grants.
    expect(calls.map((c) => c.url)).toEqual(['/api/account/entity-access?type=document&id=doc-1'])
  })

  it('renders nothing for a workspace record with no grants', async () => {
    await render({ can_share: true, restricted: false, grants: [] })
    expect(container.innerHTML).toBe('')
  })

  it('lists the grants by name, with the picker, for a private record', async () => {
    await render({ can_share: true, restricted: true, grants: GRANTS })
    const text = container.textContent ?? ''
    expect(text).toContain('People & channels with access')
    expect(text).toContain('Only you can see this document.')
    expect(text).toContain('Rosa Lind')
    expect(text).toContain('#launch')
    expect(container.querySelector('input[placeholder="Search members..."]')).not.toBeNull()
    for (const k of ['Person', 'Team', 'Channel']) expect([...container.querySelectorAll('button')].some((b) => b.textContent === k)).toBe(true)
  })

  it('removes a grant (optimistically) with one DELETE', async () => {
    await render({ can_share: true, restricted: true, grants: GRANTS })
    const remove = container.querySelector('button[aria-label="Remove #launch"]') as HTMLButtonElement
    await act(async () => {
      remove.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/account/entity-access/g-2')).toBe(true)
    expect(container.textContent).not.toContain('#launch')
    expect(container.textContent).toContain('Rosa Lind')
  })

  it('list-only: the grants and Remove, no picker, nothing without grants', async () => {
    await render({ can_share: true, restricted: true, grants: GRANTS }, true)
    expect(container.textContent).toContain('#launch')
    expect(container.querySelector('input')).toBeNull()
    expect(calls.map((c) => c.url)).toEqual(['/api/account/entity-access?type=document&id=doc-1'])
    await render({ can_share: true, restricted: true, grants: [] }, true)
    expect(container.innerHTML).toBe('')
  })
})
