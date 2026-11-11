/**
 * The verifier for Connect-forwarded requests: the deployment's own project
 * and environment on Vercel (the verifier's defaults), CONNECT_PROJECT_ID and
 * CONNECT_ENVIRONMENT off it. Every id here is made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ create: vi.fn(), verify: vi.fn() }))

vi.mock('@vercel/connect/chat', () => ({ createConnectWebhookVerifier: m.create }))

import { verifyConnectForward } from '../forwarded'

const req = () => new Request('https://nativeintelligence.dev/api/slack/events', { method: 'POST', headers: { authorization: 'Bearer oidc' }, body: '{}' })

beforeEach(() => {
  m.verify.mockReset().mockResolvedValue(true)
  m.create.mockReset().mockReturnValue(m.verify)
  vi.stubEnv('CONNECT_PROJECT_ID', undefined)
  vi.stubEnv('CONNECT_ENVIRONMENT', undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe('verifyConnectForward', () => {
  it('keeps the verifier\'s own defaults when CONNECT_PROJECT_ID is unset', async () => {
    vi.stubEnv('CONNECT_ENVIRONMENT', 'preview') // ignored without a project id
    const request = req()
    await verifyConnectForward(request, '{}')
    expect(m.create).toHaveBeenCalledWith(undefined)
    expect(m.verify).toHaveBeenCalledWith(request, '{}')
  })

  it('names the project, and production, when CONNECT_PROJECT_ID is set', async () => {
    vi.stubEnv('CONNECT_PROJECT_ID', ' prj_madeup0001 ')
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_madeup9999')
    await verifyConnectForward(req(), '{}')
    expect(m.create).toHaveBeenCalledWith({ projectId: 'prj_madeup0001', environment: 'production' })
  })

  it('names CONNECT_ENVIRONMENT when it is set too', async () => {
    vi.stubEnv('CONNECT_PROJECT_ID', 'prj_madeup0001')
    vi.stubEnv('CONNECT_ENVIRONMENT', 'preview')
    await verifyConnectForward(req(), '{}')
    expect(m.create).toHaveBeenCalledWith({ projectId: 'prj_madeup0001', environment: 'preview' })
  })

  it.each([
    ['the project id', { CONNECT_PROJECT_ID: '*', CONNECT_ENVIRONMENT: undefined }],
    ['the environment', { CONNECT_PROJECT_ID: 'prj_madeup0001', CONNECT_ENVIRONMENT: '*' }],
    ['a part of one', { CONNECT_PROJECT_ID: 'prj_madeup*', CONNECT_ENVIRONMENT: undefined }],
    ['the environment without a project id', { CONNECT_PROJECT_ID: undefined, CONNECT_ENVIRONMENT: ' * ' }],
  ])('refuses every request when %s holds a *, never widening the check', async (_label, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    await expect(verifyConnectForward(req(), '{}')).rejects.toThrow('refused')
    expect(m.create).not.toHaveBeenCalled()
    expect(m.verify).not.toHaveBeenCalled()
  })

  it('throws when the token does not verify', async () => {
    vi.stubEnv('CONNECT_PROJECT_ID', 'prj_madeup0001')
    m.verify.mockRejectedValue(new Error('Expected Vercel OIDC token project_id claim'))
    await expect(verifyConnectForward(req(), '{}')).rejects.toThrow('project_id')
  })
})
