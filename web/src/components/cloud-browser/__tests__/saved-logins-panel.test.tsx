// @vitest-environment jsdom
/**
 * The saved logins panel (src/components/cloud-browser/saved-logins-panel.tsx)
 * with a stand-in desktop: it lists what the desktop keeps, sends a new login
 * to it once and empties the password field, and never shows a password.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SavedLoginsPanel } from '../saved-logins-panel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Row = { id: string; site: string; username: string; ask: boolean }
let rows: Row[]
const bridge = {
  list: vi.fn(async () => rows.map(row => ({ ...row }))),
  save: vi.fn(async (login: { site: string; username: string; password: string }) => {
    if (!login.site.includes('.')) throw new Error('That does not look like a website (for example: example.com).')
    const row = { id: `id-${rows.length + 1}`, site: login.site, username: login.username, ask: true }
    rows.push(row)
    return row
  }),
  remove: vi.fn(async (id: string) => { rows = rows.filter(row => row.id !== id); return true }),
  setAsk: vi.fn(async (id: string, ask: boolean) => { const row = rows.find(r => r.id === id)!; row.ask = ask; return row }),
  onUsed: () => () => {},
}

let host: HTMLElement
let root: Root
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() }) }
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const type = (label: string, value: string) => act(() => {
  const el = input(label)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})

beforeEach(async () => {
  rows = [{ id: 'id-1', site: 'shop.example.com', username: 'kim@fernhill.example', ask: true }]
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<SavedLoginsPanel onClose={() => {}} bridge={bridge as never} />))
  await flush()
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('the saved logins panel', () => {
  it('lists the site and the account name, and whether it asks first', () => {
    const row = host.querySelector('[data-saved-login="shop.example.com"]')!
    expect(row.textContent).toContain('kim@fernhill.example')
    expect(row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
  })

  it('saves a login once, with no say over asking, and empties the password field', async () => {
    type('Site', ' books.example.com ')
    type('Account name', 'kim')
    type('Password', 'made-up-secret')
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-saved-logins-save]')!.click() })
    await flush()
    expect(bridge.save).toHaveBeenCalledTimes(1)
    expect(bridge.save).toHaveBeenCalledWith({ site: 'books.example.com', username: 'kim', password: 'made-up-secret' })
    expect(input('Password').value).toBe('')
    expect(input('Site').value).toBe('')
    expect(host.querySelector('[data-saved-login="books.example.com"]')).not.toBeNull()
    expect(host.textContent).not.toContain('made-up-secret')
  })

  it('says the desktop’s own reason when it refuses, and still empties the password field', async () => {
    type('Site', 'books')
    type('Account name', 'kim')
    type('Password', 'made-up-secret')
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-saved-logins-save]')!.click() })
    await flush()
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('does not look like a website')
    expect(input('Password').value).toBe('')
    // A missing field never reaches the desktop.
    bridge.save.mockClear()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-saved-logins-save]')!.click() })
    expect(bridge.save).not.toHaveBeenCalled()
  })

  it('turns asking off for one login, and removes one', async () => {
    const row = host.querySelector('[data-saved-login="shop.example.com"]')!
    await act(async () => { row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    await flush()
    expect(bridge.setAsk).toHaveBeenCalledWith('id-1', false)
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Remove')!.click() })
    await flush()
    expect(bridge.remove).toHaveBeenCalledWith('id-1')
    expect(host.textContent).toContain('No saved logins yet.')
  })
})
