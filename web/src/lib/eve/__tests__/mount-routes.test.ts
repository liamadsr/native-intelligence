/**
 * Mount-route contract: every app-side eve mount resolves, through eve's OWN
 * client URL join (client/url.js → shared/eve-route-path.js joinEveRoutePath),
 * to the named-agent route eve 0.58+ serves: `/eve/<name>/v1/*`.
 *
 * Why this exists: eve 0.58 moved named agents from `/eve/agents/<name>/eve/v1/*`
 * to `/eve/<name>/v1/*`, and the mount tests elsewhere only compare each
 * constant to a string literal. joinEveRoutePath strips the `/eve/v1` prefix
 * ONLY when the host path matches `^/eve/[a-z0-9][a-z0-9_-]*$`; any other
 * mount shape gets `/eve/v1/...` appended literally and 404s. So this drives a
 * REAL `eve/client` Client built from each dispatcher's actual constant (read
 * from its source) with a spy fetch, and asserts the exact request path.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from 'eve/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const repoRoot = resolve(__dirname, '../../../..')

/** [source file, constant name, agent name, how the host is built] */
const MOUNTS = [
  ['src/lib/chat/eve/eve-chat-transport.ts', 'CHAT_AGENT_MOUNT', 'chat-agent', 'relative'],
  ['src/lib/chat/device-ask-eve.ts', 'CHAT_AGENT_MOUNT', 'chat-agent', 'absolute'],
  // The main agent's relay to a bot's own thread (bots-v4 A4), as the person.
  ['src/lib/bots/bot-relay.ts', 'CHAT_AGENT_MOUNT', 'chat-agent', 'absolute'],
  ['src/lib/flows/run-skill-eve.ts', 'SKILL_RUNNER_MOUNT', 'skill-runner', 'absolute'],
  ['src/lib/agent-run/run-agent-eve.ts', 'CODING_AGENT_MOUNT', 'coding-agent', 'absolute'],
  ['src/lib/agent-run/run-work-eve.ts', 'WORK_AGENT_MOUNT', 'work-agent', 'absolute'],
  // The run chats' shared dispatch (bots-v4 A3: moved out of /api/account/agent-runs/[id]/chat).
  ['src/lib/agent-run/run-chat-dispatch.ts', 'WORK_AGENT_MOUNT', 'work-agent', 'absolute'],
  ['src/app/api/account/onboarding/research/route.ts', 'RESEARCHER_MOUNT', 'onboarding-researcher', 'absolute'],
  ['src/lib/eve/utility/run-utility.ts', 'UTILITY_MOUNT', 'utility', 'absolute'],
  // The kinds whose spec names the web-research agent (UtilityKindSpec.agent).
  ['src/lib/eve/utility/run-utility.ts', 'WEB_RESEARCH_MOUNT', 'web-research', 'absolute'],
  ['src/lib/live-agent/eve-turn.ts', 'LIVE_AGENT_MOUNT', 'live-agent', 'absolute'],
] as const

function mountFromSource(file: string, constName: string): string {
  const src = readFileSync(join(repoRoot, file), 'utf8')
  const m = src.match(new RegExp(`const ${constName} = '([^']+)'`))
  if (!m) throw new Error(`${constName} not found in ${file}`)
  return m[1]
}

function captureFetch(): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as Request).url))
      return new Response('{"error":"stub"}', { status: 500, headers: { 'content-type': 'application/json' } })
    }),
  )
  return urls
}

const pathOf = (u: string) => new URL(u, 'http://relative.test').pathname

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('eve mount constants resolve to /eve/<name>/v1/* through eve’s own client', () => {
  it.each(MOUNTS)('%s %s → POST /eve/%s/v1/session', async (file, constName, agent, kind) => {
    const mount = mountFromSource(file, constName)
    const host = kind === 'absolute' ? `https://app.test${mount}` : mount
    const urls = captureFetch()

    await new Client({ host }).sessions.create({ message: 'hi' }).catch(() => {})

    expect(urls.length).toBeGreaterThan(0)
    expect(pathOf(urls[0])).toBe(`/eve/${agent}/v1/session`)
  })

  it.each(MOUNTS)('%s %s → session-scoped control routes land under /eve/%s/v1/session/:id', async (file, constName, agent, kind) => {
    const mount = mountFromSource(file, constName)
    const host = kind === 'absolute' ? `https://app.test${mount}` : mount
    const urls = captureFetch()

    await new Client({ host }).sessions.attach('wrun_X').cancel().catch(() => {})

    expect(pathOf(urls[0])).toBe(`/eve/${agent}/v1/session/wrun_X/cancel`)
  })

  // Task-mode creates bypass sessions.create(): task-session.ts (skill-runner,
  // coding-agent, utility, live-agent, the device-ask chat-agent session) and the onboarding research route POST the raw path
  // '/eve/v1/session' through client.fetch(), which goes through the same
  // createClientUrl → joinEveRoutePath join the 0.58 rename broke.
  const RAW_CREATE_CALLERS = [
    ['src/lib/eve/task-session.ts', /const EVE_CREATE_SESSION_PATH = '([^']+)'/, /client\.fetch\(EVE_CREATE_SESSION_PATH,/],
    ['src/app/api/account/onboarding/research/route.ts', /client\.fetch\('([^']+)', \{/, /client\.fetch\('\/eve\/v1\/session'/],
  ] as const

  it.each(RAW_CREATE_CALLERS)('%s posts its raw create path through client.fetch()', (file, pathPattern, callPattern) => {
    const src = readFileSync(join(repoRoot, file), 'utf8')
    expect(src.match(pathPattern)?.[1]).toBe('/eve/v1/session')
    expect(src).toMatch(callPattern)
  })

  const RAW_CREATE_MOUNTS = MOUNTS.filter(([file, , agent]) =>
    agent === 'skill-runner' ||
    agent === 'coding-agent' ||
    agent === 'onboarding-researcher' ||
    agent === 'utility' ||
    agent === 'web-research' ||
    agent === 'live-agent' ||
    // /api/device/ask's task-mode chat-agent session (createTaskSession).
    file === 'src/lib/chat/device-ask-eve.ts',
  )

  it.each(RAW_CREATE_MOUNTS)('%s %s → raw client.fetch("/eve/v1/session") lands on POST /eve/%s/v1/session', async (file, constName, agent, kind) => {
    const mount = mountFromSource(file, constName)
    expect(kind).toBe('absolute')
    const urls = captureFetch()

    await new Client({ host: `https://app.test${mount}` }).fetch('/eve/v1/session', { method: 'POST' }).catch(() => {})

    expect(urls).toHaveLength(1)
    expect(pathOf(urls[0])).toBe(`/eve/${agent}/v1/session`)
  })

  it('the onboarding companion’s hand-built stream path matches the path eve’s client streams from', async () => {
    const file = 'src/app/account/onboarding/use-research-companion.ts'
    const mount = mountFromSource(file, 'AGENT_MOUNT')
    const src = readFileSync(join(repoRoot, file), 'utf8')
    // The companion builds `${AGENT_MOUNT}/v1/session/<id>/stream` by hand.
    expect(src).toContain('`${AGENT_MOUNT}/v1/session/${encodeURIComponent(sessionId)}/stream`')

    const urls = captureFetch()
    // The stream reconnects on a failed response; capture the first request,
    // then abort it.
    const stop = new AbortController()
    const stream = new Client({ host: mount })
      .sessions.attach('wrun_X')
      .stream({ follow: false, startIndex: 0, signal: stop.signal })
    const pending = stream[Symbol.asyncIterator]().next().catch(() => {})
    await vi.waitFor(() => expect(urls.length).toBeGreaterThan(0))
    stop.abort()
    await pending
    expect(pathOf(urls[0])).toBe(`${mount}/v1/session/wrun_X/stream`)
    expect(pathOf(urls[0])).toBe('/eve/onboarding-researcher/v1/session/wrun_X/stream')
  })

  it('a mount that does NOT match eve’s named-agent shape would NOT resolve to /v1/* (the failure mode this guards)', async () => {
    const urls = captureFetch()
    await new Client({ host: 'https://app.test/eve/agents/chat-agent' }).sessions.create({ message: 'hi' }).catch(() => {})
    expect(pathOf(urls[0])).toBe('/eve/agents/chat-agent/eve/v1/session')
  })
})
