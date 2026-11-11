import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const startInstallation = vi.fn()
const startAuthorization = vi.fn()
const getToken = vi.fn()
const getTokenResponse = vi.fn()
const revokeToken = vi.fn()
const connectOptions = vi.fn()
const forgetConnectProjectToken = vi.fn()

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

vi.mock('../config', () => ({ slackConnector: () => 'slack/ni-public' }))
vi.mock('../connect-auth', () => ({
  connectOptions: () => connectOptions(),
  forgetConnectProjectToken: () => forgetConnectProjectToken(),
}))

import { ConnectError } from '@vercel/connect'
import { SlackInstallUnavailableError, revokeSlackInstallation, slackBotToken, startSlackInstall, verifySlackInstallation } from '../connect'

describe('startSlackInstall', () => {
  beforeEach(() => {
    startInstallation.mockReset()
    startAuthorization.mockReset()
    connectOptions.mockReset().mockResolvedValue(undefined)
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
  const PROJECT_TOKEN = 'made-up.project.token'
  const app = { subject: { type: 'app' }, installationId: 'T0MADEUP1' }

  beforeEach(() => {
    getToken.mockReset().mockResolvedValue('xoxb-made-up')
    getTokenResponse.mockReset().mockResolvedValue({ token: 'xoxb-made-up', tenantId: 'T0MADEUP1' })
    revokeToken.mockReset().mockResolvedValue(undefined)
    startInstallation.mockReset().mockResolvedValue({ url: 'https://vercel.com/install/x' })
    connectOptions.mockReset()
    forgetConnectProjectToken.mockReset()
  })

  async function callEveryOne() {
    await slackBotToken('T0MADEUP1')
    await verifySlackInstallation('T0MADEUP1')
    await revokeSlackInstallation('T0MADEUP1')
    await startSlackInstall('https://nativeintelligence.dev/back')
  }

  it('sends the project token with every call off Vercel', async () => {
    connectOptions.mockResolvedValue({ vercelToken: PROJECT_TOKEN })
    await callEveryOne()
    expect(getToken).toHaveBeenCalledWith('slack/ni-public', app, { vercelToken: PROJECT_TOKEN })
    expect(getTokenResponse).toHaveBeenCalledWith('slack/ni-public', app, { vercelToken: PROJECT_TOKEN })
    expect(revokeToken).toHaveBeenCalledWith('slack/ni-public', app, { vercelToken: PROJECT_TOKEN })
    expect(startInstallation).toHaveBeenCalledWith('slack/ni-public', {}, { returnUrl: 'https://nativeintelligence.dev/back', vercelToken: PROJECT_TOKEN })
  })

  it('sends no options on Vercel, so the client uses the OIDC token', async () => {
    connectOptions.mockResolvedValue(undefined)
    await callEveryOne()
    for (const call of [getToken, getTokenResponse, revokeToken]) {
      expect(call).toHaveBeenCalledTimes(1)
      expect(call.mock.calls[0][2]).toBeUndefined()
    }
    expect(startInstallation).toHaveBeenCalledWith('slack/ni-public', {}, { returnUrl: 'https://nativeintelligence.dev/back' })
  })

  it('drops the project token when Connect refuses it, and only then', async () => {
    connectOptions.mockResolvedValue({ vercelToken: PROJECT_TOKEN })
    getToken.mockRejectedValueOnce(new ConnectError('forbidden', { status: 403, code: 'forbidden' }))
    await expect(slackBotToken('T0MADEUP1')).rejects.toBeInstanceOf(ConnectError)
    expect(forgetConnectProjectToken).toHaveBeenCalledTimes(1)

    getToken.mockRejectedValueOnce(new ConnectError('down', { status: 500 }))
    await expect(slackBotToken('T0MADEUP1')).rejects.toBeInstanceOf(ConnectError)
    expect(forgetConnectProjectToken).toHaveBeenCalledTimes(1)

    // On Vercel there is no project token to drop.
    connectOptions.mockResolvedValue(undefined)
    getToken.mockRejectedValueOnce(new ConnectError('forbidden', { status: 403 }))
    await expect(slackBotToken('T0MADEUP1')).rejects.toBeInstanceOf(ConnectError)
    expect(forgetConnectProjectToken).toHaveBeenCalledTimes(1)
  })

  it('makes no Connect call when the project token cannot be made', async () => {
    connectOptions.mockRejectedValue(new Error('CONNECT_PROJECT_ID is not set'))
    await expect(slackBotToken('T0MADEUP1')).rejects.toThrow('CONNECT_PROJECT_ID')
    expect(getToken).not.toHaveBeenCalled()
  })
})
