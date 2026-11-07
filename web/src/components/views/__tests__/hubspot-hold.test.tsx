// @vitest-environment jsdom
/**
 * The HubSpot push HOLD badge (Sequence step 2, plan A.1): shown only on a
 * contact that carries `metadata.hubspot_push_hold`; Release POSTs the
 * contact's hubspot-hold route and tells the owner to reload.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: hoisted.toast }))

import { HubspotHoldBadge, releaseHubspotHold } from '../hubspot-hold'

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ released: true, pushed: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const HOLD = { hubspot_push_hold: { at: '2026-09-01T00:00:00.000Z', by: 'unattended' } }

describe('HubspotHoldBadge', () => {
  it('renders nothing for a contact without the hold', () => {
    act(() => root.render(h(HubspotHoldBadge, { contactId: 'ct-1', metadata: { enrichment: {} } })))
    expect(container.querySelector('[data-testid="hubspot-hold-badge"]')).toBeNull()
    act(() => root.render(h(HubspotHoldBadge, { contactId: 'ct-1', metadata: null })))
    expect(container.querySelector('[data-testid="hubspot-hold-badge"]')).toBeNull()
  })

  it('shows the hold, and Release POSTs the route and reports back', async () => {
    const onReleased = vi.fn()
    act(() => root.render(h(HubspotHoldBadge, { contactId: 'ct-1', metadata: HOLD, onReleased })))
    const badge = container.querySelector('[data-testid="hubspot-hold-badge"]')
    expect(badge?.textContent).toContain('HubSpot sync held')
    const button = badge?.querySelector('button') as HTMLButtonElement
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/account/contacts/ct-1/hubspot-hold', { method: 'POST' })
    expect(onReleased).toHaveBeenCalledTimes(1)
    expect(hoisted.toast.success).toHaveBeenCalled()
  })

  it('a failed release says so and does not report back', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 500 }))
    const onReleased = vi.fn()
    act(() => root.render(h(HubspotHoldBadge, { contactId: 'ct-1', metadata: HOLD, onReleased })))
    const button = container.querySelector('[data-testid="hubspot-hold-badge"] button') as HTMLButtonElement
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(onReleased).not.toHaveBeenCalled()
    expect(hoisted.toast.error).toHaveBeenCalled()
  })

  it('releaseHubspotHold resolves false on a network error', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('offline')
    })
    expect(await releaseHubspotHold('ct-1')).toBe(false)
  })
})
