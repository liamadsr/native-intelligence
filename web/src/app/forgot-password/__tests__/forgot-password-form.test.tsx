// @vitest-environment jsdom
/**
 * "Forgot password?" asks Supabase to send the link back where it was asked
 * for: a browser's own /reset-password, or, in the desktop app, the desktop
 * callback, which hands the link's code to the app (its web view holds the
 * verifier; the email link itself always opens in the system browser).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const m = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(async (_email: string, _opts: { redirectTo: string }) => ({ error: null as { message: string } | null })),
  desktop: false,
}))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { resetPasswordForEmail: m.resetPasswordForEmail } }) }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => m.desktop }))

const { ForgotPasswordForm } = await import('../forgot-password-form')

let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', window.location.origin)
  m.resetPasswordForEmail.mockReset().mockResolvedValue({ error: null })
  m.desktop = false
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<ForgotPasswordForm />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllEnvs()
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

describe('ForgotPasswordForm', () => {
  it("in a browser, asks for the link back on this browser's reset page", async () => {
    await send(' person@example.com ')
    expect(m.resetPasswordForEmail).toHaveBeenCalledWith('person@example.com', { redirectTo: `${window.location.origin}/reset-password` })
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'If an account exists for that email, a reset link is on its way. Open it in this browser.',
    )
  })

  it('in the desktop app, asks for the link back through the desktop callback, into the app', async () => {
    m.desktop = true
    await send('person@example.com')
    expect(m.resetPasswordForEmail).toHaveBeenCalledWith('person@example.com', {
      redirectTo: `${window.location.origin}/auth/desktop-callback`,
    })
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'If an account exists for that email, a reset link is on its way. Open it on this computer and it will bring you back to the app.',
    )
  })

  it("shows Supabase's error", async () => {
    m.resetPasswordForEmail.mockResolvedValueOnce({ error: { message: 'Too many requests' } })
    await send('person@example.com')
    expect(container.textContent).toContain('Too many requests')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})
