// @vitest-environment jsdom
/**
 * /reset-password: a reset link that failed (`?error=`) leaves the form shut,
 * even when this browser is already signed in, so a new password can't land on
 * whichever account that session belongs to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const m = vi.hoisted(() => ({ getSession: vi.fn(async () => ({ data: { session: { user: { id: 'a' } } as unknown } })) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { getSession: m.getSession } }) }))

const { ResetPasswordForm } = await import('../reset-password-form')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  m.getSession.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(linkFailed?: boolean) {
  await act(async () => {
    root.render(<ResetPasswordForm linkFailed={linkFailed} />)
  })
  const password = container.querySelector<HTMLInputElement>('#password')!
  return { disabled: password.disabled, expired: /invalid or has expired/.test(container.textContent ?? '') }
}

describe('ResetPasswordForm', () => {
  it('opens for the recovery session a working link made', async () => {
    expect(await render()).toEqual({ disabled: false, expired: false })
  })

  it('stays shut after a failed link, though the browser has a session', async () => {
    expect(await render(true)).toEqual({ disabled: true, expired: true })
    expect(m.getSession).not.toHaveBeenCalled()
  })

  it('stays shut with no session at all', async () => {
    m.getSession.mockResolvedValueOnce({ data: { session: null } })
    expect(await render()).toEqual({ disabled: true, expired: true })
  })
})

describe('ResetPasswordPage', () => {
  it('shuts the form for any ?error= a reset link came back with', async () => {
    const { default: ResetPasswordPage } = await import('../page')
    const page = (searchParams: Record<string, string>) => ResetPasswordPage({ searchParams: Promise.resolve(searchParams) })
    expect((await page({ error: 'link_expired' })).props.linkFailed).toBe(true)
    expect((await page({ error: '' })).props.linkFailed).toBe(true)
    expect((await page({})).props.linkFailed).toBe(false)
  })
})
