// @vitest-environment jsdom
/**
 * A sign-in card (cloud-browser/sign-in-card.ts): a browser task reached a
 * site's sign-in page. The card opens the agent's browser with the person
 * driving, and answers itself once when they hand it back; its own button
 * says "I'm signed in". Never on a card from another workspace, and never on
 * any other approval.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaces: () => ({ workspaces: [{ id: 'ws-1', name: 'Fernhill Studio' }, { id: 'ws-2', name: 'Other' }], currentId: 'ws-1' }) }))

import { AttentionCard } from '../attention-card'
import type { AttentionItem } from '@/hooks/use-attention-items'
import { __resetComputerForTests, getComputer, refreshComputer, setDriver } from '@/lib/cloud-browser/computer-client'

const card = (payload: Record<string, unknown>, workspaceId = 'ws-1'): AttentionItem =>
  ({
    id: 'appr-card-1', workspace_id: workspaceId, member_id: 'm-1', kind: 'approval',
    title: 'shop.example.com needs you to sign in', why: 'I was working on "List my open orders" and it asked me to sign in.',
    payload: { approval_id: 'appr-1', tool: 'run_browser_task', side_effect: 'external-write', door: 'chat', input: { goal: 'List my open orders' }, ...payload },
    proposal_id: null, source_flow_run_id: null, status: 'pending', expires_at: null, created_at: new Date().toISOString(),
  }) as unknown as AttentionItem

let container: HTMLDivElement
let root: Root
const onAccept = vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, status: 'executed' }))
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ driver: 'person' }), { status: 200 }))

function render(item: AttentionItem) {
  act(() => {
    root.render(h(AttentionCard, { item, editable: true, members: [], aiMembers: [], projects: [], surface: 'chat',
      onEdit: vi.fn(), onAccept, onStart: vi.fn(async () => ({ ok: true })), onDismiss: vi.fn(async () => {}) } as never))
  })
}
const openButton = () => container.querySelector<HTMLButtonElement>('[data-approval-sign-in]')
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
  __resetComputerForTests()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('a sign-in card', () => {
  it('its one main button is Sign in: it opens the agent’s browser with the person driving, then says they are done', async () => {
    render(card({ browser_sign_in: { site: 'shop.example.com' } }))
    expect(openButton()!.textContent).toBe('Sign in')
    expect(container.textContent).toContain('Not now')
    // Plain words only: no Approve, and none of the task's raw inputs.
    for (const noise of ['Approve', 'Decline', 'goal', 'completion', 'startUrl']) expect(container.textContent).not.toContain(noise)
    await act(async () => { openButton()!.click() })
    await flush()
    expect(openButton()!.textContent).toBe('I\'m signed in, continue')
    expect(container.querySelector('[data-approval-sign-in-again]')).not.toBeNull()
    expect(getComputer()).toMatchObject({ viewOpen: true, driver: 'person' })
    expect(fetchMock).toHaveBeenCalledWith('/api/account/browser/driver', expect.objectContaining({ body: JSON.stringify({ driver: 'person' }) }))
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('after Sign in, the main button runs the task again when pressed', async () => {
    render(card({ browser_sign_in: { site: 'shop.example.com' } }))
    await act(async () => { openButton()!.click() })
    await flush()
    await act(async () => { openButton()!.click() })
    await flush()
    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  it('answers itself once when the person hands the browser back', async () => {
    render(card({ browser_sign_in: { site: 'shop.example.com' } }))
    await act(async () => { openButton()!.click() })
    await flush()
    await act(async () => { await setDriver('agent') })
    await flush()
    expect(onAccept).toHaveBeenCalledTimes(1)
    // A later take over that this card did not start never answers it again.
    await act(async () => { await setDriver('person') })
    await act(async () => { await setDriver('agent') })
    await flush()
    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  it('a state read that still says the agent drives never answers the card while the person signs in', async () => {
    render(card({ browser_sign_in: { site: 'shop.example.com' } }))
    await act(async () => { openButton()!.click() })
    await flush()
    // A read sent before the take over landed.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ exists: true, status: 'running', driver: 'agent' }), { status: 200 }))
    await act(async () => { await refreshComputer() })
    await flush()
    expect(getComputer().driver).toBe('agent')
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('a card that no longer waits is not answered by a hand back', async () => {
    const item = card({ browser_sign_in: { site: 'shop.example.com' } })
    render(item)
    await act(async () => { openButton()!.click() })
    await flush()
    render({ ...item, status: 'accepted' } as typeof item)
    await act(async () => { await setDriver('agent') })
    await flush()
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('a hand back the card did not start answers nothing', async () => {
    render(card({ browser_sign_in: { site: 'shop.example.com' } }))
    await act(async () => { await setDriver('person') })
    await act(async () => { await setDriver('agent') })
    await flush()
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('a take over that was refused never arms the card', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 409 }))
    render(card({ browser_sign_in: { site: 'shop.example.com' } }))
    await act(async () => { openButton()!.click() })
    await flush()
    expect(getComputer().driver).toBe('agent')
    await act(async () => { await setDriver('person') })
    await act(async () => { await setDriver('agent') })
    await flush()
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('no button on another approval, or on a card from another workspace (the live view is this workspace’s browser)', () => {
    render(card({}))
    expect(openButton()).toBeNull()
    expect(container.textContent).toContain('Approve')
    expect(container.textContent).toContain('goal')
    render(card({ browser_sign_in: { site: 'shop.example.com' } }, 'ws-2'))
    expect(openButton()).toBeNull()
  })
})
