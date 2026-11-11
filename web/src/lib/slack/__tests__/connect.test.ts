import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const startInstallation = vi.fn()
const startAuthorization = vi.fn()
const getToken = vi.fn()
const getTokenResponse = vi.fn()
const revokeToken = vi.fn()

vi.mock('@vercel/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vercel/connect')>()
  return {
    ...actual,
    experimental_startInstallation: (...args: unknown[]) => startInstallation(...args),
    startAuthorization: (...args: unknown[]) => startAuthorization(...args),
    getToken: (...args: unknown[]) => getToken(...args),
    getTokenResponse: (...args: unknown[]) => getTokenResponse(...args),
    revokeToken: (...args: unknown[]) => revokeToken(...args),
  }
})

vi.mock('../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config')>()),
  slackConnector: () => 'slack/ni-public',
}))

import { ConnectError } from '@vercel/connect'
import { SlackInstallUnavailableError, revokeSlackInstallation, slackBotToken, startSlackInstall, verifySlackInstallation } from '../connect'

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

describe('how Connect calls authenticate', () => {
  const TOKEN = 'made-up-access-token'
  const app = { subject: { type: 'app' }, installationId: 'T0MADEUP1' }

  beforeEach(() => {
    getToken.mockReset().mockResolvedValue('xoxb-made-up')
    getTokenResponse.mockReset().mockResolvedValue({ token: 'xoxb-made-up', tenantId: 'T0MADEUP1' })
    revokeToken.mockReset().mockResolvedValue(undefined)
    startInstallation.mockReset().mockResolvedValue({ url: 'https://vercel.com/install/x' })
  })
  afterEach(() => vi.unstubAllEnvs())

  async function callEveryOne() {
    await slackBotToken('T0MADEUP1')
    await verifySlackInstallation('T0MADEUP1')
    await revokeSlackInstallation('T0MADEUP1')
    await startSlackInstall('https://nativeintelligence.dev/back')
  }

  it('sends CONNECT_ACCESS_TOKEN with every call when it is set (off Vercel)', async () => {
    vi.stubEnv('CONNECT_ACCESS_TOKEN', ` ${TOKEN}\n`)
    await callEveryOne()
    expect(getToken).toHaveBeenCalledWith('slack/ni-public', app, { vercelToken: TOKEN })
    expect(getTokenResponse).toHaveBeenCalledWith('slack/ni-public', app, { vercelToken: TOKEN })
    expect(revokeToken).toHaveBeenCalledWith('slack/ni-public', app, { vercelToken: TOKEN })
    expect(startInstallation).toHaveBeenCalledWith('slack/ni-public', {}, { returnUrl: 'https://nativeintelligence.dev/back', vercelToken: TOKEN })
  })

  it.each([['unset', undefined], ['empty', '  ']])('sends no token when it is %s, so the client uses the OIDC token', async (_label, value) => {
    vi.stubEnv('CONNECT_ACCESS_TOKEN', value)
    await callEveryOne()
    for (const call of [getToken, getTokenResponse, revokeToken]) {
      expect(call).toHaveBeenCalledTimes(1)
      expect(call.mock.calls[0][2]).toBeUndefined()
    }
    expect(startInstallation).toHaveBeenCalledWith('slack/ni-public', {}, { returnUrl: 'https://nativeintelligence.dev/back' })
  })
})
