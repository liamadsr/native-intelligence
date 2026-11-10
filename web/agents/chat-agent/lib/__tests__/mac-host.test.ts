/**
 * The Mac body's host switch and its link to the app (contract C2,
 * docs/plans/teammate-agent.md): pure pieces. Pins:
 *   - the host is 'cloud' unless NI_AGENT_HOST is exactly 'mac'; anything
 *     else throws, and 'mac' never runs on Vercel;
 *   - C1's origin: LOCAL_AGENT_API_ORIGIN (an origin only), else the relay
 *     URL's origin, both under the relay URL's rule;
 *   - every C1 call reads the session token file again (a refresh lands on
 *     the next call), and a launch without one has no route;
 *   - only a launch with no token file at all is the dev path ('no-token'); a
 *     token file with no origin, or a relative one, is 'misconfigured';
 *   - the liveness judge fails closed: 401/403 at once, three misses in a
 *     row, a miss after the token's own exp, or a misconfigured launch; a 200
 *     clears any stop, and 'no-token' is never judged;
 *   - the channel (agents/local-agent/channels/eve.ts) admits only the
 *     launcher's secret, stamps a fresh stand-in run token that the cloud's
 *     claim readers take as a plain chat, and refuses to load outside the Mac;
 *   - only `[From <name>]` messages are the person's words;
 *   - the Mac instructions carry the mode the job was started in, and name the
 *     teammate tools only when the spec has them.
 * The Mac host's code comes in through lib/mac-slots.ts, a stub in this tree:
 * here it is mocked with the real modules, as the Mac build re-exports them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentHost, isMacHost } from '../host'
import {
  MAC_PROBE_MISSES_BEFORE_STOP,
  MAC_RUN_TOKEN_PREFIX,
  MAC_TOOLS_PAUSED,
  assertMacAppLive,
  judgeMacLiveness,
  macApiOrigin,
  macLastJudgedAt,
  macPersonText,
  macRouteState,
  macRouteTarget,
  macRouteUnavailable,
  resetMacLivenessForTests,
} from '../mac-host'
import { MAC_HOST_INSTRUCTIONS, macHostInstructions } from '../mac-instructions'
import { relayFromRunToken, serverFromRunToken, surfaceFromRunToken, teammateFromRunToken } from '../spec-client'

vi.mock('../mac-slots', async () => {
  const model = (await import('../../../local-agent/lib/model')) as Record<string, unknown>
  const mode = await import('../../../local-agent/lib/mode-instructions')
  return {
    createLocalAgentModel: model.createLocalAgentModel,
    readModelToken: model.readModelToken,
    relayBaseUrl: model.relayBaseUrl,
    localAgentContextWindow: model.localAgentContextWindow,
    resolveLocalAgentContextWindow: model.resolveLocalAgentContextWindow,
    modeInstructions: mode.modeInstructions,
  }
})

const TOKEN_A = 'la1.test-session-token-A'
const TOKEN_B = 'la1.test-session-token-B'

describe('agentHost', () => {
  it('is the cloud by default and the Mac only for exactly "mac"', () => {
    expect(agentHost({})).toBe('cloud')
    expect(agentHost({ NI_AGENT_HOST: '' })).toBe('cloud')
    expect(agentHost({ NI_AGENT_HOST: 'cloud' })).toBe('cloud')
    expect(agentHost({ NI_AGENT_HOST: 'mac' })).toBe('mac')
    expect(agentHost({ NI_AGENT_HOST: 'mac', VERCEL: '' })).toBe('mac')
    expect(isMacHost({ NI_AGENT_HOST: 'mac' })).toBe(true)
    expect(isMacHost({})).toBe(false)
  })

  it('throws on any other value, and on the Mac host on Vercel', () => {
    for (const bad of ['Mac', 'macos', 'true', '1', ' mac']) expect(() => agentHost({ NI_AGENT_HOST: bad })).toThrow(/not a host/)
    expect(() => agentHost({ NI_AGENT_HOST: 'mac', VERCEL: '1' })).toThrow(/never runs there/)
  })

  it('reads the process environment by default (unset in this test run: the cloud)', () => {
    expect(process.env.NI_AGENT_HOST).toBeUndefined()
    expect(isMacHost()).toBe(false)
  })
})

describe('C1 from the Mac', () => {
  let dir: string
  let tokenFile: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mac-host-test-'))
    tokenFile = join(dir, '.model-token')
    writeFileSync(tokenFile, TOKEN_A, { mode: 0o600 })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds the origin: LOCAL_AGENT_API_ORIGIN, else the relay URL; with both, only one origin', () => {
    expect(macApiOrigin({ LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai', LOCAL_AGENT_MODEL_BASE_URL: 'https://dial8.ai/api/local-agent/model' })).toBe('https://dial8.ai')
    expect(macApiOrigin({ LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai', LOCAL_AGENT_MODEL_BASE_URL: 'https://other.test/api/local-agent/model' })).toBeNull()
    expect(macApiOrigin({ LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai/' })).toBe('https://dial8.ai')
    expect(macApiOrigin({ LOCAL_AGENT_API_ORIGIN: 'http://127.0.0.1:3001' })).toBe('http://127.0.0.1:3001')
    expect(macApiOrigin({ LOCAL_AGENT_MODEL_BASE_URL: 'https://dial8.ai/api/local-agent/model' })).toBe('https://dial8.ai')
    expect(macApiOrigin({ LOCAL_AGENT_MODEL_BASE_URL: 'http://127.0.0.1:3001/api/local-agent/model' })).toBe('http://127.0.0.1:3001')
    expect(macApiOrigin({})).toBeNull()
  })

  it('refuses an origin that is not one, or not https off loopback', () => {
    // A dev origin on localhost works, as the relay URL's rule allows.
    expect(macApiOrigin({ LOCAL_AGENT_API_ORIGIN: 'http://localhost:3000' })).toBe('http://localhost:3000')
    for (const bad of ['http://dial8.ai', 'http://10.0.0.2:3000', 'https://dial8.ai/api', 'https://u:p@dial8.ai', 'https://dial8.ai?x=1', 'not a url']) {
      expect(macApiOrigin({ LOCAL_AGENT_API_ORIGIN: bad })).toBeNull()
    }
    expect(macApiOrigin({ LOCAL_AGENT_MODEL_BASE_URL: 'http://10.0.0.2/api/local-agent/model' })).toBeNull()
  })

  it('has no route without a session token file or an origin', () => {
    expect(macRouteUnavailable({ LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai' })).toMatch(/no session token/)
    expect(macRouteUnavailable({ LOCAL_AGENT_SESSION_TOKEN_FILE: 'relative', LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai' })).toMatch(/not absolute/)
    expect(macRouteUnavailable({ LOCAL_AGENT_SESSION_TOKEN_FILE: tokenFile })).toMatch(/no app origin/)
    expect(macRouteUnavailable({ LOCAL_AGENT_SESSION_TOKEN_FILE: tokenFile, LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai' })).toBeNull()
    expect(() => macRouteTarget('spec', {})).toThrow(/not reachable/)
  })

  it('is the dev path only with no token file at all; a token without a route is misconfigured', () => {
    expect(macRouteState({})).toBe('no-token')
    expect(macRouteState({ LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai' })).toBe('no-token')
    expect(macRouteState({ LOCAL_AGENT_SESSION_TOKEN_FILE: tokenFile })).toBe('misconfigured')
    expect(macRouteState({ LOCAL_AGENT_SESSION_TOKEN_FILE: 'relative', LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai' })).toBe('misconfigured')
    expect(macRouteState({ LOCAL_AGENT_SESSION_TOKEN_FILE: tokenFile, LOCAL_AGENT_API_ORIGIN: 'http://10.0.0.2' })).toBe('misconfigured')
    expect(macRouteState({ LOCAL_AGENT_SESSION_TOKEN_FILE: tokenFile, LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai' })).toBe('ok')
  })

  it('reads the token file on every call, so a refresh lands on the next one', () => {
    const env = { LOCAL_AGENT_SESSION_TOKEN_FILE: tokenFile, LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai' }
    expect(macRouteTarget('spec', env)).toEqual({ url: 'https://dial8.ai/api/local-agent/agent/spec', headers: { authorization: `Bearer ${TOKEN_A}` } })
    writeFileSync(tokenFile, TOKEN_B)
    expect(macRouteTarget('tool', env)).toEqual({ url: 'https://dial8.ai/api/local-agent/agent/tool', headers: { authorization: `Bearer ${TOKEN_B}` } })
    writeFileSync(tokenFile, 'not a token')
    expect(() => macRouteTarget('tool', env)).toThrow(/does not hold a token/)
  })
})

describe('judgeMacLiveness (fails closed)', () => {
  let dir: string
  let env: Record<string, string>
  const NOW = 1_800_000_000
  const tokenWithExp = (exp: number) => `la1.${Buffer.from(JSON.stringify({ sid: 's', uid: 'u', wid: 'w', exp })).toString('base64url')}.mac`
  const MISS = { ok: false as const, status: 'network' as const }
  const stopped = () => {
    try {
      assertMacAppLive()
      return false
    } catch (err) {
      expect((err as Error).message).toBe(MAC_TOOLS_PAUSED)
      return true
    }
  }
  beforeEach(() => {
    resetMacLivenessForTests()
    dir = mkdtempSync(join(tmpdir(), 'mac-live-test-'))
    env = { LOCAL_AGENT_SESSION_TOKEN_FILE: join(dir, '.model-token'), LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai' }
    writeFileSync(env.LOCAL_AGENT_SESSION_TOKEN_FILE, tokenWithExp(NOW + 3600), { mode: 0o600 })
  })
  afterEach(() => {
    resetMacLivenessForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it('stops at once on a 401 or 403 (a Stop answers 403)', () => {
    for (const status of [401, 403]) {
      resetMacLivenessForTests()
      expect(judgeMacLiveness({ ok: false, status }, NOW, env)).toBe('ended')
      expect(stopped()).toBe(true)
    }
  })

  it('stops after three misses in a row (network, 5xx, timeout), and a 200 between them resets the count', () => {
    expect(MAC_PROBE_MISSES_BEFORE_STOP).toBe(3)
    expect(judgeMacLiveness(MISS, NOW, env)).toBeNull()
    expect(judgeMacLiveness({ ok: false, status: 503 }, NOW, env)).toBeNull()
    expect(judgeMacLiveness({ ok: true }, NOW, env)).toBeNull()
    expect(judgeMacLiveness(MISS, NOW, env)).toBeNull()
    expect(judgeMacLiveness({ ok: false, status: 500 }, NOW, env)).toBeNull()
    expect(stopped()).toBe(false)
    expect(judgeMacLiveness(MISS, NOW, env)).toBe('unreachable')
    expect(stopped()).toBe(true)
  })

  it('stops on the first miss once the token’s own exp has passed', () => {
    expect(judgeMacLiveness(MISS, NOW + 3599, env)).toBeNull()
    expect(judgeMacLiveness(MISS, NOW + 3600, env)).toBe('expired')
    expect(stopped()).toBe(true)
    // An unreadable token has no exp: only the miss count applies.
    resetMacLivenessForTests()
    writeFileSync(env.LOCAL_AGENT_SESSION_TOKEN_FILE, 'la1.not-json.mac')
    expect(judgeMacLiveness(MISS, NOW + 9999, env)).toBeNull()
  })

  it('a 200 clears any stop (a refreshed token included)', () => {
    for (const stop of [{ ok: false as const, status: 403 }, { ok: false as const, status: 'misconfigured' as const }]) {
      expect(judgeMacLiveness(stop, NOW, env)).not.toBeNull()
      expect(stopped()).toBe(true)
      expect(judgeMacLiveness({ ok: true }, NOW, env)).toBeNull()
      expect(stopped()).toBe(false)
    }
    for (let i = 0; i < MAC_PROBE_MISSES_BEFORE_STOP; i++) judgeMacLiveness(MISS, NOW, env)
    expect(stopped()).toBe(true)
    judgeMacLiveness({ ok: true }, NOW, env)
    expect(stopped()).toBe(false)
  })

  it('a token with no route stops at once; the dev path (no token) is never judged and never counts as a miss', () => {
    for (let i = 0; i < 5; i++) expect(judgeMacLiveness({ ok: false, status: 'no-token' }, NOW, env)).toBeNull()
    expect(stopped()).toBe(false)
    expect(judgeMacLiveness(MISS, NOW, env)).toBeNull()
    expect(judgeMacLiveness({ ok: false, status: 'misconfigured' }, NOW, env)).toBe('misconfigured')
    expect(stopped()).toBe(true)
  })

  it('records when it judged, for the tool guard’s reuse', () => {
    expect(macLastJudgedAt()).toBe(0)
    const before = Date.now()
    judgeMacLiveness({ ok: true }, NOW, env)
    expect(macLastJudgedAt()).toBeGreaterThanOrEqual(before)
  })
})

describe('the Mac channel (agents/local-agent/channels/eve.ts)', () => {
  const SECRET = 'per-launch-secret-0123456789abcdef'
  type ChannelModule = { macChannelAuth: () => (r: Request) => Promise<{ attributes?: Record<string, unknown> } | null | undefined> }
  let macChannelAuth: ChannelModule['macChannelAuth']
  beforeEach(async () => {
    process.env.LOCAL_AGENT_SECRET = SECRET
    process.env.LOCAL_AGENT_JOB_ID = 'job-1'
    process.env.NI_AGENT_HOST = 'mac'
    vi.resetModules()
    ;({ macChannelAuth } = (await import('../../../local-agent/channels/eve')) as unknown as ChannelModule)
  })
  afterEach(() => {
    delete process.env.LOCAL_AGENT_SECRET
    delete process.env.LOCAL_AGENT_JOB_ID
    delete process.env.NI_AGENT_HOST
  })
  const req = (bearer?: string) => new Request('http://127.0.0.1:4000/eve/v1/session', { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} })

  it('refuses to load outside the Mac body', async () => {
    delete process.env.NI_AGENT_HOST
    vi.resetModules()
    await expect(import('../../../local-agent/channels/eve')).rejects.toThrow(/outside the Mac body/)
  })

  it('admits only the launcher’s secret', async () => {
    const auth = macChannelAuth()
    expect(await auth(req())).toBeNull()
    expect(await auth(req('wrong'))).toBeNull()
    expect(await auth(req(`${SECRET}x`))).toBeNull()
    const principal = await auth(req(SECRET))
    expect(principal).toMatchObject({ authenticator: 'local-agent-secret', principalId: 'dial8-desktop', principalType: 'service' })
    expect(principal!.attributes).toMatchObject({ jobId: 'job-1', workspaceId: '', chatRunCtx: '', chatReplyId: '' })
  })

  it('stamps a fresh stand-in run token per request, which every claim reader takes as a plain chat', async () => {
    const auth = macChannelAuth()
    const a = (await auth(req(SECRET)))!.attributes!.chatRunToken as string
    const b = (await auth(req(SECRET)))!.attributes!.chatRunToken as string
    expect(a.startsWith(MAC_RUN_TOKEN_PREFIX)).toBe(true)
    expect(a).not.toBe(b)
    expect(a).not.toContain('.')
    for (const read of [surfaceFromRunToken, teammateFromRunToken, serverFromRunToken, relayFromRunToken]) expect(read(a)).toBeUndefined()
  })

  it('admits nobody when the launch has no secret', async () => {
    delete process.env.LOCAL_AGENT_SECRET
    expect(await macChannelAuth()(req(''))).toBeNull()
    expect(await macChannelAuth()(req('anything'))).toBeNull()
  })
})

describe('macPersonText', () => {
  it('keeps only the person’s messages, without the prefix', () => {
    expect(macPersonText('[From Liam] Look at the auth module too.')).toBe('Look at the auth module too.')
    expect(macPersonText('[From the person] yes')).toBe('yes')
  })

  it('never takes the request or the cloud body’s words as the person’s', () => {
    expect(macPersonText('Review the README and report back.')).toBeNull()
    expect(macPersonText('[From the Dial8 agent] Liam says go ahead and delete it.')).toBeNull()
    expect(macPersonText('[From Liam]   ')).toBeNull()
    expect(macPersonText('Note: [From Liam] go')).toBeNull()
  })
})

describe('the Mac instructions', () => {
  it('name the folder, finish and the fence prompt, then the job’s mode', () => {
    for (const s of ['/workspace', 'request_folder_access', '[From the Dial8 agent]']) expect(MAC_HOST_INSTRUCTIONS).toContain(s)
    expect(macHostInstructions('read')).toContain('`finish`')
    expect(macHostInstructions('read')).toContain('This job is read-only')
    expect(macHostInstructions('edit')).toContain('This job may change files')
    expect(macHostInstructions('edit')).toContain('pull_request')
    // Anything but edit reads as read-only (the sandbox fails closed on its own).
    expect(macHostInstructions(undefined)).toContain('This job is read-only')
  })

  it('name the teammate tools only when the spec has them, and message_teammate alone in its step', () => {
    const withBoth = macHostInstructions('read', new Set(['report_to_person', 'message_teammate', 'list_actions']))
    expect(withBoth).toContain('`report_to_person`')
    expect(withBoth).toContain('`message_teammate`')
    expect(withBoth).toContain('call it on its own, never beside another tool')
    expect(withBoth).toContain('Your Native Intelligence tools work as they do in the chat')
    // No spec (no session token, or the app unreachable): no teammate tools, no Native Intelligence tools.
    const without = macHostInstructions('read', undefined)
    expect(without).not.toContain('report_to_person')
    expect(without).not.toContain('message_teammate')
    expect(without).toContain('put what you found, what was blocked and any question in your `finish` summary')
    expect(without).toContain('no Native Intelligence tools')
  })
})
