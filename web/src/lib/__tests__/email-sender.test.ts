/**
 * The app's sender (lib/email.ts sendEmail): every email goes out From
 * EMAIL_FROM. Unset, nothing is sent: one log line, and the same
 * `{ data: null, error }` a refused Resend send answers. Never a built-in
 * address.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { send } = vi.hoisted(() => ({
  send: vi.fn(async (_m: unknown) => ({ data: { id: 'email-1' }, error: null, headers: null })),
}))
vi.mock('resend', () => ({
  Resend: class {
    emails = { send }
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: vi.fn() }))
vi.mock('@/lib/posthog', () => ({ getPostHogServerClient: () => null, serverDefaultProperties: {} }))

import { emailFrom, sendCampaignEmail, sendEmail } from '../email'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  send.mockClear()
})

describe('sendEmail', () => {
  it('sends From EMAIL_FROM', async () => {
    vi.stubEnv('EMAIL_FROM', ' Example Team <team@example.com> ')
    const res = await sendEmail({ to: 'pat@example.com', subject: 'Hi', html: '<p>Hi</p>' })
    expect(res.error).toBeNull()
    expect(send).toHaveBeenCalledExactlyOnceWith({
      to: 'pat@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      from: 'Example Team <team@example.com>',
    })
  })

  it('refuses to send without EMAIL_FROM: one log line, a Resend-shaped error', async () => {
    vi.stubEnv('EMAIL_FROM', '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(emailFrom()).toBeNull()
    const res = await sendEmail({ to: 'pat@example.com', subject: 'Hi', html: '<p>Hi</p>' })
    expect(send).not.toHaveBeenCalled()
    expect(res.data).toBeNull()
    expect(res.error).toMatchObject({ name: 'missing_required_field', message: 'EMAIL_FROM is not set' })
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain('EMAIL_FROM')
  })

  it('a campaign send fails the way a refused send already does', async () => {
    vi.stubEnv('EMAIL_FROM', '')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const single = vi.fn(async () => ({ data: { slug: 'welcome', name: 'Welcome', subject: 'Hi', html: '<p>Hi</p>' }, error: null }))
    const supabase = { from: () => ({ select: () => ({ eq: () => ({ single }) }) }) }
    await expect(
      sendCampaignEmail({ to: 'pat@example.com', step: 'welcome', supabase: supabase as never }),
    ).rejects.toThrow('Email send failed: EMAIL_FROM is not set')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('no built-in sender', () => {
  it('reads the sender from EMAIL_FROM, with no address to fall back to', () => {
    const source = readFileSync(path.join(__dirname, '..', 'email.ts'), 'utf8')
    expect(source).not.toMatch(/FROM_EMAIL\s*=/)
    expect(source).toContain('process.env.EMAIL_FROM')
  })

  it('every app email goes through sendEmail: lib/email.ts is the only caller of Resend', () => {
    const srcRoot = path.join(__dirname, '..', '..')
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(entry.name) && /\.emails\.send\(/.test(readFileSync(full, 'utf8'))) {
          callers.push(path.relative(srcRoot, full))
        }
      }
    }
    walk(srcRoot)
    expect(callers).toEqual([path.join('lib', 'email.ts')])
  })
})
