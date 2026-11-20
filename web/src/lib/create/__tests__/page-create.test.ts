// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { openTarget } = vi.hoisted(() => ({ openTarget: vi.fn((..._a: unknown[]) => true) }))
vi.mock('@/lib/chat-cards/open-card', () => ({ openTarget }))

import { __resetPageCreateForTests, openPageCreate, takePageCreate, PAGE_CREATE_EVENT } from '../page-create'

beforeEach(() => {
  __resetPageCreateForTests()
  openTarget.mockClear()
})

describe('openPageCreate', () => {
  it('opens the page as everything opens a page, and asks its view once', () => {
    const asked = vi.fn()
    window.addEventListener(PAGE_CREATE_EVENT, asked)
    openPageCreate('sequence', 'sequences')
    window.removeEventListener(PAGE_CREATE_EVENT, asked)
    expect(openTarget).toHaveBeenCalledWith({ type: 'page', slug: 'sequences' }, { from: 'create' })
    expect(asked).toHaveBeenCalledTimes(1)
    expect(takePageCreate('campaign')).toBe(false)
    expect(takePageCreate('sequence')).toBe(true)
    expect(takePageCreate('sequence')).toBe(false)
  })

  it('lets a request go stale: a page opened much later starts no create', () => {
    openPageCreate('agent', 'agents')
    expect(takePageCreate('agent', Date.now() + 60_000)).toBe(false)
    expect(takePageCreate('agent')).toBe(false)
  })
})
