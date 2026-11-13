// @vitest-environment jsdom
/**
 * Settings → Workspace "Joining": owners and admins see the three switches,
 * the link with Copy and Reset, their own domain's line and the other listed
 * domains with Remove (on a public address: "Unavailable" and why); a member
 * sees only the link to copy, and only while members can invite; otherwise
 * the section renders nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { JoinSettingsView } from '@/lib/workspace-join/view'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/switch', () => ({
  Switch: ({ checked, disabled, onCheckedChange, 'aria-label': label }: {
    checked: boolean; disabled?: boolean; onCheckedChange: (v: boolean) => void; 'aria-label'?: string
  }) => h('button', { 'data-switch': label, 'data-checked': String(checked), disabled, onClick: () => onCheckedChange(!checked) }),
}))

import { JoiningSection } from '../joining-section'

const URL_ = 'https://app.example/join/Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0'

function view(over: Partial<JoinSettingsView> = {}): JoinSettingsView {
  return {
    role: 'owner',
    canManage: true,
    membersCanInvite: false,
    invitableRoles: ['admin', 'member', 'guest'],
    link: { enabled: true, url: URL_ },
    byDomain: { domains: [], yourDomain: 'acme.example', unavailableReason: null },
    ...over,
  }
}

let root: Root
let container: HTMLDivElement
const fetchMock = vi.fn()
const onChange = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  onChange.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = (v: JoinSettingsView | null) => act(() => root.render(h(JoiningSection, { view: v, onChange })))
const switches = () => Array.from(container.querySelectorAll('[data-switch]')).map((b) => b.getAttribute('data-switch'))
const buttonNamed = (name: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined

describe('JoiningSection', () => {
  it('an owner: three switches, the link with Copy and Reset, the domain line', () => {
    render(view())
    expect(switches()).toEqual(['Invite link', 'Join by email domain', 'Members can invite people'])
    expect((container.querySelector('input') as HTMLInputElement).value).toBe(URL_)
    expect(buttonNamed('Copy')).toBeTruthy()
    expect(buttonNamed('Reset')).toBeTruthy()
    expect(container.textContent).toContain('People with an @acme.example email can join')
    expect(container.textContent).toContain('Nobody is added without it')
  })

  it('a public address: "Unavailable" with the reason, the switch disabled, no @gmail.com headline', () => {
    render(view({ byDomain: { domains: [], yourDomain: null, unavailableReason: '@gmail.com is a public or shared email provider, so anyone could use it.' } }))
    const domain = container.querySelector('[data-switch="Join by email domain"]') as HTMLButtonElement
    expect(domain.disabled).toBe(true)
    expect(container.textContent).toContain('Unavailable: @gmail.com is a public or shared email provider')
    expect(container.textContent).not.toContain('People with an @gmail.com email')
  })

  it('switching it on sends only `by_domain: true`, never a domain', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(view({ byDomain: { domains: ['acme.example'], yourDomain: 'acme.example', unavailableReason: null } })), { status: 200 }))
    render(view())
    await act(async () => (container.querySelector('[data-switch="Join by email domain"]') as HTMLButtonElement).click())
    expect(fetchMock).toHaveBeenCalledWith('/api/account/workspace/join', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ by_domain: true }) }))
    expect(onChange).toHaveBeenCalled()
  })

  it('other admins’ domains are listed with Remove', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(view()), { status: 200 }))
    render(view({ byDomain: { domains: ['acme-labs.example', 'acme.example'], yourDomain: 'acme.example', unavailableReason: null } }))
    expect((container.querySelector('[data-switch="Join by email domain"]') as HTMLButtonElement).getAttribute('data-checked')).toBe('true')
    expect(container.textContent).toContain('People with an @acme-labs.example email can join')
    await act(async () => buttonNamed('Remove')!.click())
    expect(fetchMock).toHaveBeenCalledWith('/api/account/workspace/join', expect.objectContaining({ body: JSON.stringify({ remove_domains: ['acme-labs.example'] }) }))
  })

  it('a member allowed to invite: the link and Copy, no switches, no Reset', () => {
    render(view({ role: 'member', canManage: false, membersCanInvite: true, invitableRoles: ['member', 'guest'] }))
    expect(switches()).toEqual([])
    expect(buttonNamed('Copy')).toBeTruthy()
    expect(buttonNamed('Reset')).toBeUndefined()
  })

  it('a member without it, or a guest: nothing', () => {
    render(view({ role: 'member', canManage: false, invitableRoles: [], link: { enabled: true, url: null } }))
    expect(container.innerHTML).toBe('')
    render(null)
    expect(container.innerHTML).toBe('')
  })
})
