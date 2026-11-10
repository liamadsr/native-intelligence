/**
 * The browser-side step after a merge: the source workspace's localStorage is
 * swept, the local Exchange allow-list carries the source's entry over to the
 * destination, and the window lands in the destination.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ setClientWorkspaceId: vi.fn() }))
vi.mock('@/lib/workspace-fetch', () => ({ setClientWorkspaceId: hoisted.setClientWorkspaceId }))

import { sweepWorkspaceLocalState, finishWorkspaceMerge, LAST_CHAT_WORKSPACE_KEY, LOCAL_EXCHANGE_WORKSPACES_KEY, type StorageLike } from '../after-merge'

const SRC = '11111111-1111-4111-8111-111111111111'
const DST = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'

class FakeStorage implements StorageLike {
  private map = new Map<string, string>()
  constructor(entries: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(entries)) this.map.set(k, v)
  }
  get length() {
    return this.map.size
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null
  }
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  keys() {
    return [...this.map.keys()].sort()
  }
}

describe('sweepWorkspaceLocalState', () => {
  it('removes every key naming the source and nothing else', () => {
    const s = new FakeStorage({
      [`ni-chat:${SRC}`]: '{}',
      [`ni:active-view:${SRC}:actions`]: 'v1',
      [`ni:home-conversation-adopted:${SRC}`]: '1',
      [`ni:onboarding-checklist-opened:${SRC}`]: '1',
      [`knowledge-view-mode:${SRC}`]: 'grid',
      [`ni:calendar-events:v1:${SRC}`]: '[]',
      [`ni-chat:${DST}`]: '{}',
      [`ni:active-view:${DST}:actions`]: 'v2',
      theme: 'dark',
    })
    const out = sweepWorkspaceLocalState(s, SRC, DST)
    expect(out.removed.sort()).toEqual(
      [
        `ni-chat:${SRC}`,
        `ni:active-view:${SRC}:actions`,
        `ni:home-conversation-adopted:${SRC}`,
        `ni:onboarding-checklist-opened:${SRC}`,
        `knowledge-view-mode:${SRC}`,
        `ni:calendar-events:v1:${SRC}`,
      ].sort(),
    )
    expect(s.keys()).toEqual([`ni-chat:${DST}`, `ni:active-view:${DST}:actions`, 'theme'])
    expect(out.rewritten).toEqual([])
  })

  it('carries the source over to the destination in the local Exchange allow-list, deduped, in order', () => {
    const s = new FakeStorage({ [LOCAL_EXCHANGE_WORKSPACES_KEY]: JSON.stringify([OTHER, SRC]) })
    const out = sweepWorkspaceLocalState(s, SRC, DST)
    expect(JSON.parse(s.getItem(LOCAL_EXCHANGE_WORKSPACES_KEY)!)).toEqual([OTHER, DST])
    expect(out.rewritten).toEqual([LOCAL_EXCHANGE_WORKSPACES_KEY])
    expect(out.removed).toEqual([])

    const both = new FakeStorage({ [LOCAL_EXCHANGE_WORKSPACES_KEY]: JSON.stringify([SRC, DST]) })
    sweepWorkspaceLocalState(both, SRC, DST)
    expect(JSON.parse(both.getItem(LOCAL_EXCHANGE_WORKSPACES_KEY)!)).toEqual([DST])
  })

  it('re-points the chat’s last-workspace pointer, whose VALUE is the id, and leaves another value alone', () => {
    const s = new FakeStorage({ [LAST_CHAT_WORKSPACE_KEY]: SRC, [`ni-chat:${SRC}`]: '{}' })
    const out = sweepWorkspaceLocalState(s, SRC, DST)
    expect(s.getItem(LAST_CHAT_WORKSPACE_KEY)).toBe(DST)
    expect(out.rewritten).toEqual([LAST_CHAT_WORKSPACE_KEY])
    expect(out.removed).toEqual([`ni-chat:${SRC}`])

    const other = new FakeStorage({ [LAST_CHAT_WORKSPACE_KEY]: OTHER })
    expect(sweepWorkspaceLocalState(other, SRC, DST).rewritten).toEqual([])
    expect(other.getItem(LAST_CHAT_WORKSPACE_KEY)).toBe(OTHER)
  })

  it('leaves an allow-list that does not name the source, or is unreadable, alone', () => {
    const clean = new FakeStorage({ [LOCAL_EXCHANGE_WORKSPACES_KEY]: JSON.stringify([OTHER]) })
    expect(sweepWorkspaceLocalState(clean, SRC, DST).rewritten).toEqual([])
    expect(clean.getItem(LOCAL_EXCHANGE_WORKSPACES_KEY)).toBe(JSON.stringify([OTHER]))

    const broken = new FakeStorage({ [LOCAL_EXCHANGE_WORKSPACES_KEY]: '{not json' })
    expect(sweepWorkspaceLocalState(broken, SRC, DST).rewritten).toEqual([])
    expect(broken.getItem(LOCAL_EXCHANGE_WORKSPACES_KEY)).toBe('{not json')
  })

  it('an empty source id sweeps nothing (never wipes every key)', () => {
    const s = new FakeStorage({ a: '1', b: '2' })
    expect(sweepWorkspaceLocalState(s, '', DST)).toEqual({ removed: [], rewritten: [] })
    expect(s.keys()).toEqual(['a', 'b'])
  })
})

describe('finishWorkspaceMerge', () => {
  const assign = vi.fn()
  let storage: FakeStorage
  beforeEach(() => {
    hoisted.setClientWorkspaceId.mockReset()
    assign.mockReset()
    storage = new FakeStorage({ [`ni-chat:${SRC}`]: '{}' })
    vi.stubGlobal('window', { localStorage: storage, location: { assign } })
  })

  it('sweeps, points the fetch layer at the destination, then hard-navigates', () => {
    const out = finishWorkspaceMerge(SRC, DST)
    expect(out.removed).toEqual([`ni-chat:${SRC}`])
    expect(hoisted.setClientWorkspaceId).toHaveBeenCalledWith(DST)
    expect(assign).toHaveBeenCalledWith('/account')
    expect(hoisted.setClientWorkspaceId.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0])
  })

  it('still lands in the destination when storage is blocked', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('SecurityError')
      },
      location: { assign },
    })
    const out = finishWorkspaceMerge(SRC, DST, '/account/settings')
    expect(out).toEqual({ removed: [], rewritten: [] })
    expect(hoisted.setClientWorkspaceId).toHaveBeenCalledWith(DST)
    expect(assign).toHaveBeenCalledWith('/account/settings')
  })
})
