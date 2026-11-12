// @vitest-environment jsdom
/**
 * Copy availability's "Manage booking links" (../copy-availability-button.tsx)
 * opens the Availability page (Liam, 11-11: its own page under Calendar, out
 * of Settings): its card in the chat; where there is no chat, the dashboard's
 * `?page=` deep link. The menu is drawn flat here (no Radix portal).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

const hoisted = vi.hoisted(() => ({ canOpen: true, push: vi.fn(), openTarget: vi.fn(() => true) }))
vi.mock('@/components/account-filter-dropdown', () => ({ useHasConnectedAccount: () => true }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: hoisted.push }) }))
vi.mock('@/app/account/(dashboard)/main-chat/main-chat-context', () => ({ useCanOpenCards: () => hoisted.canOpen }))
vi.mock('@/lib/chat-cards/open-card', () => ({
  openTarget: hoisted.openTarget,
  pageDeepLink: (slug: string) => `/account?page=${slug}`,
}))
vi.mock('@/components/ui/dropdown-menu', () => {
  const pass = ({ children }: { children?: ReactNode }) => h('div', null, children)
  return {
    DropdownMenu: pass,
    DropdownMenuTrigger: pass,
    DropdownMenuContent: pass,
    DropdownMenuLabel: pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({ children, onSelect, ...rest }: { children?: ReactNode; onSelect?: () => void }) =>
      h('button', { type: 'button', onClick: () => onSelect?.(), ...rest }, children),
  }
})

import { CopyAvailabilityButton } from '../copy-availability-button'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Manage booking links', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    hoisted.push.mockClear()
    hoisted.openTarget.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ links: [], user_id: 'me' }) })))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const manage = () => container.querySelector<HTMLButtonElement>('[data-manage-booking-links]')!

  it('in the dashboard: opens the Availability page’s card', () => {
    hoisted.canOpen = true
    act(() => root.render(h(CopyAvailabilityButton)))
    act(() => manage().click())
    expect(hoisted.openTarget).toHaveBeenCalledWith({ type: 'page', slug: 'availability' }, { from: 'calendar' })
    expect(hoisted.push).not.toHaveBeenCalled()
  })

  it('with no chat to open it in: the dashboard’s deep link to it', () => {
    hoisted.canOpen = false
    act(() => root.render(h(CopyAvailabilityButton)))
    act(() => manage().click())
    expect(hoisted.openTarget).not.toHaveBeenCalled()
    expect(hoisted.push).toHaveBeenCalledWith('/account?page=availability')
  })
})
