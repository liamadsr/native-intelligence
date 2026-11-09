// @vitest-environment jsdom
/**
 * "What Native Intelligence has learned" (one-agent plan Part 3, "Memory"): the buttons each
 * viewer gets, as migration 317 allows (lineActions), and the editor showing
 * them: a member sees the workspace's lines read-only, its proposals waiting
 * (withdrawing only their own); an owner or admin accepts, dismisses, edits
 * and deletes them; everyone manages their own lines, Native Intelligence's suggestions
 * included. What Native Intelligence noticed about you is live (Liam, 2026-10-17), marked,
 * with a one-tap Remove and an Undo that adds it back. With an area, the
 * editor shows only that area's note.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { WhatDial8Learned, groupMemoryLines, lineActions } from '../what-dial8-learned'
import type { MemoryLine } from '@/lib/packs/memory-types'
import type { ProfileFact } from '@/lib/memory/profile-facts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const ME = 'user-me'
const line = (over: Partial<MemoryLine>): MemoryLine => ({
  id: 'l',
  area: 'mail',
  scope: 'personal',
  status: 'active',
  source: 'told',
  text: 'a line',
  created_by: ME,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
})
const member = { userId: ME, canManageWorkspace: false }
const admin = { userId: ME, canManageWorkspace: true }

describe('lineActions', () => {
  it('your own lines are yours to edit and delete, and Native Intelligence’s suggestions yours to accept or dismiss', () => {
    expect(lineActions(line({}), member)).toMatchObject({ edit: true, delete: true, remove: false, accept: false })
    // Live and Native Intelligence's own: Remove (one tap, with Undo) in place of Delete.
    expect(lineActions(line({ source: 'learned', created_by: null }), member)).toMatchObject({ edit: true, delete: false, remove: true, accept: false })
    expect(lineActions(line({ status: 'proposed', source: 'learned', created_by: null }), member)).toMatchObject({ accept: true, dismiss: true, waitingForAdmin: false })
  })

  it('a member reads the workspace’s lines, waits on its proposals, and withdraws only their own', () => {
    expect(lineActions(line({ scope: 'workspace', created_by: 'user-admin' }), member)).toEqual({
      edit: false, delete: false, remove: false, accept: false, dismiss: false, withdraw: false, waitingForAdmin: false,
    })
    expect(lineActions(line({ scope: 'workspace', status: 'proposed' }), member)).toMatchObject({ waitingForAdmin: true, withdraw: true, accept: false })
    expect(lineActions(line({ scope: 'workspace', status: 'proposed', created_by: 'user-you' }), member)).toMatchObject({ waitingForAdmin: true, withdraw: false })
  })

  it('an owner or admin settles the workspace’s proposals and changes its lines', () => {
    expect(lineActions(line({ scope: 'workspace', status: 'proposed', created_by: 'user-you' }), admin)).toMatchObject({ accept: true, dismiss: true, waitingForAdmin: false })
    expect(lineActions(line({ scope: 'workspace', created_by: 'user-you' }), admin)).toMatchObject({ edit: true, delete: true })
  })
})

describe('groupMemoryLines', () => {
  it('lists only areas with lines, in registry order, yours apart from the workspace’s; or just the one area asked for', () => {
    const lines = [line({ id: '1', area: 'crm', scope: 'workspace' }), line({ id: '2', area: 'mail' }), line({ id: '3', area: 'mail', scope: 'workspace' })]
    const all = groupMemoryLines(lines)
    expect(all.map((s) => s.area)).toEqual(['mail', 'crm'])
    expect(all[0].personal.map((l) => l.id)).toEqual(['2'])
    expect(all[0].workspace.map((l) => l.id)).toEqual(['3'])
    expect(groupMemoryLines(lines, 'calendar')).toEqual([{ area: 'calendar', name: 'Calendar', personal: [], workspace: [] }])
  })
})

describe('WhatDial8Learned', () => {
  let container: HTMLDivElement
  let root: Root
  const fetchMock = vi.fn()
  // About you (migration 328) loads its own facts once the notes are in.
  let profileFacts: ProfileFact[] = []
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    fetchMock.mockReset()
    profileFacts = []
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/account/memory/profile'
        ? new Response(JSON.stringify({ facts: profileFacts }), { status: 200 })
        : new Response('{"error":"unexpected"}', { status: 500 }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const lines = [
    line({ id: 'mine', text: 'Sign off with Best' }),
    line({ id: 'learned', text: 'You keep emails short', status: 'proposed', source: 'learned', created_by: null }),
    line({ id: 'team', scope: 'workspace', text: 'We reply within a day', created_by: 'user-admin' }),
    line({ id: 'prop', scope: 'workspace', status: 'proposed', text: 'Cc sales on pricing', created_by: 'user-you' }),
  ]
  const mount = async (canManageWorkspace: boolean, area?: 'mail') => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ userId: ME, canManageWorkspace, lines }), { status: 200 }))
    await act(async () => root.render(h(WhatDial8Learned, area ? { area } : {})))
  }
  const row = (text: string) => [...container.querySelectorAll('[data-testid="memory-line"]')].find((r) => r.textContent?.includes(text))!
  const buttons = (text: string) => [...row(text).querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())

  it('as a member: own lines editable, the suggestion acceptable, the workspace read-only, its proposal waiting', async () => {
    await mount(false)
    expect(fetchMock).toHaveBeenCalledWith('/api/account/memory', expect.objectContaining({ method: 'GET' }))
    expect(buttons('Sign off with Best')).toEqual(['Edit', 'Delete'])
    expect(buttons('You keep emails short')).toEqual(['Accept', 'Dismiss', 'Edit'])
    expect(row('You keep emails short').textContent).toContain('Native Intelligence noticed this')
    expect(buttons('We reply within a day')).toEqual([])
    expect(buttons('Cc sales on pricing')).toEqual([])
    expect(row('Cc sales on pricing').textContent).toContain('Waiting for an admin')
    // Adding a workspace line proposes it.
    const whose = container.querySelector('select[aria-label="Whose"]') as HTMLSelectElement
    await act(async () => {
      whose.value = 'workspace'
      whose.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('Propose')
  })

  it('as an admin: the workspace’s proposal can be accepted, and accepting it asks the server', async () => {
    await mount(true)
    expect(buttons('Cc sales on pricing')).toEqual(['Accept', 'Dismiss', 'Edit'])
    expect(buttons('We reply within a day')).toEqual(['Edit', 'Delete'])
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ line: { ...lines[3], status: 'active' } }), { status: 200 }))
    const accept = [...row('Cc sales on pricing').querySelectorAll('button')].find((b) => b.textContent?.includes('Accept'))!
    await act(async () => accept.click())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/memory/prop', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ status: 'active' }) }))
    expect(buttons('Cc sales on pricing')).toEqual(['Edit', 'Delete'])
  })

  it('dismissing deletes the line and drops it from the list', async () => {
    await mount(false)
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    const dismiss = [...row('You keep emails short').querySelectorAll('button')].find((b) => b.textContent?.includes('Dismiss'))!
    await act(async () => dismiss.click())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/memory/learned', expect.objectContaining({ method: 'DELETE' }))
    expect(container.textContent).not.toContain('You keep emails short')
  })

  it('adding what Native Intelligence suggested accepts that line in place, never listing it twice', async () => {
    await mount(false)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ line: { ...lines[1], status: 'active', source: 'edited' }, already: false }), { status: 200 }))
    const input = container.querySelector('input[aria-label="New line"]') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, 'You keep emails short')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const add = [...input.parentElement!.querySelectorAll('button')].find((b) => b.textContent?.includes('Add'))!
    await act(async () => add.click())
    expect(container.querySelectorAll('[data-testid="memory-line"]')).toHaveLength(4)
    expect(buttons('You keep emails short')).toEqual(['Edit', 'Delete'])
  })

  it('with an area, asks for that area only and shows no area picker, and no About you', async () => {
    await mount(false, 'mail')
    expect(fetchMock).toHaveBeenCalledWith('/api/account/memory?area=mail', expect.anything())
    expect(container.querySelector('select[aria-label="Area"]')).toBeNull()
    expect(container.querySelector('[data-testid="about-you"]')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/account/memory/profile', expect.anything())
  })

  const fact = (over: Partial<ProfileFact>): ProfileFact => ({
    id: 'f',
    text: 'a fact',
    status: 'active',
    source: 'told',
    importance: 3,
    source_workspace_id: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  })
  const factRow = (text: string) => [...container.querySelectorAll('[data-testid="profile-fact"]')].find((r) => r.textContent?.includes(text))!
  const factButtons = (text: string) => [...factRow(text).querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())

  it('About you lists the facts about the person: theirs to edit or delete, a proposal to accept or dismiss', async () => {
    profileFacts = [fact({ id: 'short', text: 'Keep answers short' }), fact({ id: 'early', text: 'Works early mornings', status: 'proposed', source: 'learned' })]
    await mount(false)
    expect(fetchMock).toHaveBeenCalledWith('/api/account/memory/profile', expect.objectContaining({ method: 'GET' }))
    expect(container.querySelector('[data-testid="about-you"]')?.textContent).toContain('About you')
    expect(factButtons('Keep answers short')).toEqual(['Edit', 'Delete'])
    expect(factButtons('Works early mornings')).toEqual(['Accept', 'Dismiss', 'Edit'])
    expect(factRow('Works early mornings').textContent).toContain('Native Intelligence noticed this')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fact: { ...profileFacts[1], status: 'active' } }), { status: 200 }))
    const accept = [...factRow('Works early mornings').querySelectorAll('button')].find((b) => b.textContent?.includes('Accept'))!
    await act(async () => accept.click())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/memory/profile/early', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ status: 'active' }) }))
    // Live now, still Native Intelligence's: marked, with Remove.
    expect(factButtons('Works early mornings')).toEqual(['Edit', 'Remove'])
    expect(factRow('Works early mornings').textContent).toContain('Native Intelligence noticed this')

    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    const del = [...factRow('Keep answers short').querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Delete')!
    await act(async () => del.click())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/memory/profile/short', expect.objectContaining({ method: 'DELETE' }))
    expect(container.querySelectorAll('[data-testid="profile-fact"]')).toHaveLength(1)
  })

  it('a live line Native Intelligence noticed: marked, one tap removes it, and Undo adds it back as yours', async () => {
    toastMock.success.mockClear()
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ userId: ME, canManageWorkspace: false, lines: [line({ id: 'noticed', text: 'Signs off with Cheers', source: 'learned', created_by: null })] }), { status: 200 }),
    )
    await act(async () => root.render(h(WhatDial8Learned, {})))
    expect(row('Signs off with Cheers').textContent).toContain('Native Intelligence noticed this')
    expect(buttons('Signs off with Cheers')).toEqual(['Edit', 'Remove'])

    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    const remove = [...row('Signs off with Cheers').querySelectorAll('button')].find((b) => b.textContent?.includes('Remove'))!
    await act(async () => remove.click())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/memory/noticed', expect.objectContaining({ method: 'DELETE' }))
    expect(container.textContent).not.toContain('Signs off with Cheers')

    // The toast's Undo puts it back, through the person's own add.
    const [message, opts] = toastMock.success.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }]
    expect(message).toBe('Removed')
    expect(opts.action.label).toBe('Undo')
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ line: line({ id: 'back', text: 'Signs off with Cheers', source: 'edited' }), already: false }), { status: 201 }),
    )
    await act(async () => {
      opts.action.onClick()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/memory', expect.objectContaining({ method: 'POST', body: JSON.stringify({ area: 'mail', scope: 'personal', text: 'Signs off with Cheers' }) }))
    expect(buttons('Signs off with Cheers')).toEqual(['Edit', 'Delete'])
  })

  it('a fact Native Intelligence noticed: one tap removes it, and Undo adds it back', async () => {
    toastMock.success.mockClear()
    profileFacts = [fact({ id: 'noticed', text: 'Prefers bullet points', source: 'learned' })]
    await mount(false)
    expect(factButtons('Prefers bullet points')).toEqual(['Edit', 'Remove'])
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    const remove = [...factRow('Prefers bullet points').querySelectorAll('button')].find((b) => b.textContent?.includes('Remove'))!
    await act(async () => remove.click())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/memory/profile/noticed', expect.objectContaining({ method: 'DELETE' }))
    expect(container.querySelectorAll('[data-testid="profile-fact"]')).toHaveLength(0)
    const [, opts] = toastMock.success.mock.calls[0] as [string, { action: { onClick: () => void } }]
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fact: fact({ id: 'back', text: 'Prefers bullet points', source: 'edited' }), already: false }), { status: 201 }))
    await act(async () => {
      opts.action.onClick()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/memory/profile', expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Prefers bullet points' }) }))
    expect(factButtons('Prefers bullet points')).toEqual(['Edit', 'Delete'])
  })

  it('About you adds a typed fact, and refuses contact details before asking', async () => {
    await mount(false)
    const input = container.querySelector('input[aria-label="New fact about you"]') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, 'Email me at liam@example.com')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[data-testid="about-you"]')?.textContent).toContain('email address')
    await act(async () => {
      setValue.call(input, 'Prefers bullet points')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fact: fact({ id: 'bullets', text: 'Prefers bullet points', source: 'edited' }), already: false }), { status: 201 }))
    const add = [...input.parentElement!.querySelectorAll('button')].find((b) => b.textContent?.includes('Add'))!
    await act(async () => add.click())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/memory/profile', expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Prefers bullet points' }) }))
    expect(factRow('Prefers bullet points')).toBeTruthy()
  })
})
