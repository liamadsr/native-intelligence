import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const startInstallation = vi.fn()
const startAuthorization = vi.fn()

vi.mock('@vercel/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vercel/connect')>()
  return {
    ...actual,
    experimental_startInstallation: (...args: unknown[]) => startInstallation(...args),
    startAuthorization: (...args: unknown[]) => startAuthorization(...args),
  }
})

vi.mock('../config', () => ({ slackConnector: () => 'slack/ni-public' }))

import { ConnectError } from '@vercel/connect'
import { SlackInstallUnavailableError, startSlackInstall } from '../connect'

describe('startSlackInstall', () => {
  beforeEach(() => {
    startInstallation.mockReset()
    startAuthorization.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('returns Connect\'s installation URL', async () => {
    startInstallation.mockResolvedValue({ url: 'https://vercel.com/install/x' })
    await expect(startSlackInstall('https://nativeintelligence.dev/back')).resolves.toBe('https://vercel.com/install/x')
    expect(startInstallation).toHaveBeenCalledWith('slack/ni-public', {}, { returnUrl: 'https://nativeintelligence.dev/back' })
  })

  it.each([403, 404])('says installs are unavailable on a %i, and never falls back to an app authorization', async (status) => {
    startInstallation.mockRejectedValue(new ConnectError('nope', { status, code: 'not_found' }))
    await expect(startSlackInstall('https://nativeintelligence.dev/back')).rejects.toBeInstanceOf(SlackInstallUnavailableError)
    expect(startAuthorization).not.toHaveBeenCalled()
  })

  it('rethrows other Connect errors', async () => {
    const error = new ConnectError('down', { status: 500 })
    startInstallation.mockRejectedValue(error)
    await expect(startSlackInstall('https://nativeintelligence.dev/back')).rejects.toBe(error)
  })
})
