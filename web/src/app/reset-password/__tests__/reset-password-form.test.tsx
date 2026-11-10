// @vitest-environment jsdom
/**
 * /reset-password: a reset link that failed (`?error=`) leaves the form shut,
 * even when this browser is already signed in, so a new password can't land on
 * whichever account that session belongs to. Instead the page says why (a link
 * only works in the browser or app where it was asked for) and offers a new
 * link right there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const m = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({ data: { session: { user: { id: 'a' } } as unknown } })),
  resetPasswordForEmail: vi.fn(async (_email: string, _opts: { redirectTo: string }) => ({ error: null as { message: string } | null })),
  desktop: false,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: m.getSession, resetPasswordForEmail: m.resetPasswordForEmail } }),
}))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => m.desktop }))

const { ResetPasswordForm } = await import('../reset-password-form')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  m.getSession.mockClear()
  m.resetPasswordForEmail.mockClear()
  m.desktop = false
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(linkError?: string) {
  await act(async () => {
    root.render(<ResetPasswordForm linkError={linkError} />)
  })
  const password = container.querySelector<HTMLInputElement>('#password')
  return {
    passwordForm: password ? (password.disabled ? 'shut' : 'open') : 'absent',
    message: container.querySelector('[role="alert"]')?.textContent ?? null,
    newLinkForm: Boolean(container.querySelector('#email')),
  }
}

describe('ResetPasswordForm', () => {
  it('opens for the recovery session a working link made', async () => {
    expect(await render()).toEqual({ passwordForm: 'open', message: null, newLinkForm: false })
  })

  it('stays shut after a failed link, though the browser has a session, and offers a new link', async () => {
    const page = await render('auth_failed')
    expect(page.passwordForm).toBe('absent')
    expect(page.newLinkForm).toBe(true)
    expect(page.message).toMatch(/didn't work/)
    expect(page.message).toMatch(/only in the browser or app where you asked for it/)
    expect(m.getSession).not.toHaveBeenCalled()
  })

  it('says a link opened somewhere else has to be opened where it was asked for', async () => {
    const page = await render('opened_elsewhere')
    expect(page.passwordForm).toBe('absent')
    expect(page.message).toBe(
      'This reset link has to be opened in the browser or app where you asked for it. Open it there, or ask for a new link here.',
    )
    expect(page.newLinkForm).toBe(true)
  })

  it('says an expired link expired', async () => {
    expect((await render('link_expired')).message).toBe('This reset link has expired or has already been used. Ask for a new link here.')
  })

  it('stays shut with no session at all, and points to the email instead of blaming a link', async () => {
    m.getSession.mockResolvedValueOnce({ data: { session: null } })
    const page = await render()
    expect(page.passwordForm).toBe('absent')
    expect(page.newLinkForm).toBe(true)
    expect(page.message).toBe(
      'Open the reset link from your email in the browser or app where you asked for it, or ask for a new link here.',
    )
  })

  it('asks for the new link right here: in a browser, back to this browser', async () => {
    await render('opened_elsewhere')
    await send('person@example.com')
    expect(m.resetPasswordForEmail).toHaveBeenCalledWith('person@example.com', { redirectTo: `${window.location.origin}/reset-password` })
    expect(container.textContent).toContain('Open it in this browser.')
  })

  it('asks for the new link right here: in the desktop app, back to the app', async () => {
    m.desktop = true
    await render('opened_elsewhere')
    await send('person@example.com')
    expect(m.resetPasswordForEmail).toHaveBeenCalledWith('person@example.com', {
      redirectTo: `${window.location.origin}/auth/desktop-callback`,
    })
    expect(container.textContent).toContain('Open it on this computer')
  })
})

async function send(email: string) {
  const input = container.querySelector<HTMLInputElement>('#email')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, email)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.form!.requestSubmit()
  })
}

describe('ResetPasswordPage', () => {
  it('passes any ?error= a reset link came back with on to the form, which stays shut for it', async () => {
    const { default: ResetPasswordPage } = await import('../page')
    const page = (searchParams: Record<string, string | string[]>) => ResetPasswordPage({ searchParams: Promise.resolve(searchParams) })
    expect((await page({ error: 'opened_elsewhere' })).props.linkError).toBe('opened_elsewhere')
    expect((await page({ error: '' })).props.linkError).toBe('')
    expect((await page({ error: ['link_expired', 'x'] })).props.linkError).toBe('link_expired')
    expect((await page({ error: [] })).props.linkError).toBe('')
    expect((await page({})).props.linkError).toBeUndefined()
  })
})
