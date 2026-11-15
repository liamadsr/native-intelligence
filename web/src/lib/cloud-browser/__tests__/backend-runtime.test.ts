/**
 * The cloud browser on the runtime backend (src/lib/cloud-browser/backend-runtime.ts,
 * driven through host.ts as the app drives it) against a fake `e2b` client and
 * a mocked row store:
 *  - create: from the template, with exactly the expected options and metadata,
 *    no internet until the relay's start, a lifetime that pauses (never kills);
 *  - two creates for one name end with one sandbox (the first in a shared order);
 *  - wake (connect + lifetime), a running one reused with the same session,
 *    a listed-but-dead one replaced, an unreachable one never killed;
 *  - stop: stop.sh, then pause, never waking a paused one; destroy kills;
 *  - the network for both modes, never a header rule; the relay token written
 *    by the file API, never in a command line or env; the key never in an error;
 *  - the reconcile: orphans, and browsers unused past the profile's lifetime.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rt = vi.hoisted(() => {
  interface Box {
    sandboxId: string
    metadata: Record<string, string>
    state: 'running' | 'paused'
    startedAt: Date
    /** Listed as running, but its agent is gone (the runtime restarted under it). */
    dead?: 'not-running' | 'unreachable'
    /** Being paused: the runtime still lists it running for this many more getInfo calls, then paused (and resumable). */
    pausingFor?: number
    /** /usr/local still open in it (the root step never ran, or failed). */
    usrLocalOpen?: boolean
    files: Map<string, string>
    lines: { line: string; detached: boolean; envs: unknown; user?: string }[]
    network: unknown[]
    timeouts: number[]
    runStart?: string
    relayBuild?: string
  }
  const boxes = new Map<string, Box>()
  const events: string[] = []
  const creates: { template: string; options: Record<string, unknown> }[] = []
  let seq = 0
  /** Runs inside create(), before it returns: a concurrent caller's create, for the race tests. */
  const hooks = { duringCreate: null as null | (() => void), createError: null as null | Error,
    /** How the root step on a new sandbox goes: it closes /usr/local, it fails, or it runs but leaves it open. */
    close: 'ok' as 'ok' | 'throw' | 'open', closeLine: '', checkLine: '' }
  const named = (name: string, message: string) => Object.assign(new Error(message), { name })

  /** The words of a command line the backend built with shellQuote. */
  function words(line: string): string[] {
    const out: string[] = []
    const re = /'((?:[^']|'\\'')*)'/g
    for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1].split("'\\''").join("'"))
    return out
  }

  function answer(box: Box, line: string): string {
    if (line === hooks.closeLine) {
      if (hooks.close === 'open') return ''
      box.usrLocalOpen = false
      return 'closed\n'
    }
    if (line === hooks.checkLine) return box.usrLocalOpen ? '' : 'closed\n'
    if (line.startsWith('cat /tmp/cloud-browser-run-start')) return box.runStart ?? ''
    const runStart = /^printf '%s' (\d+) > \/tmp\/cloud-browser-run-start$/.exec(line)
    if (runStart) { box.runStart = runStart[1]; return '' }
    if (line.includes('mv -f /tmp/cloud-browser-relay/secret/token.new')) {
      const next = box.files.get('/tmp/cloud-browser-relay/secret/token.new')
      if (next === undefined) return ''
      box.files.delete('/tmp/cloud-browser-relay/secret/token.new')
      box.files.set('/tmp/cloud-browser-relay/secret/token', next)
      return 'ok\n'
    }
    const argv = words(line)
    if (argv[1] === '-c' && argv[2]?.includes('127.0.0.1:9222/json/version')) return '200\n'
    if (argv[1] === '-c' && argv[2]?.includes('cloud-browser-relay/build')) return `build=${box.relayBuild ?? ''}\nup=1\nfailed=\n`
    if (argv[1] === '-c' && argv[3] === 'relay-start') box.relayBuild = argv[5]
    return ''
  }

  function instance(box: Box) {
    return {
      sandboxId: box.sandboxId,
      commands: {
        run: async (line: string, options: { timeoutMs?: number; envs?: unknown; user?: string }) => {
          if (!boxes.has(box.sandboxId) || box.state !== 'running' || box.dead === 'not-running') throw named('SandboxNotRunningError', 'The sandbox is not running')
          if (box.dead === 'unreachable') throw named('SandboxUnreachableError', 'The sandbox could not be reached')
          box.lines.push({ line, detached: options.timeoutMs === 0, envs: options.envs, ...(options.user ? { user: options.user } : {}) })
          if (line === hooks.closeLine && hooks.close === 'throw') throw Object.assign(new Error('exit status 1'), { name: 'CommandExitError', exitCode: 1 })
          events.push(`run ${box.sandboxId} ${line}`)
          const stdout = answer(box, line)
          return { pid: 1, wait: async () => ({ exitCode: 0, stdout, stderr: '' }), disconnect: async () => {} }
        },
      },
      files: {
        write: async (path: string, data: string) => {
          box.files.set(path, data)
          events.push(`write ${box.sandboxId} ${path}`)
        },
      },
      setTimeout: async (ms: number) => { box.timeouts.push(ms) },
      updateNetwork: async (network: unknown) => { box.network.push(network); events.push(`network ${box.sandboxId}`) },
      pause: async () => {
        events.push(`pause ${box.sandboxId}`)
        const was = box.state
        box.state = 'paused'
        return was === 'running'
      },
    }
  }

  function add(metadata: Record<string, string>, over: Partial<Box> = {}): Box {
    const box: Box = { sandboxId: `sbx${++seq}`, metadata, state: 'running', startedAt: new Date(Date.now() + seq), files: new Map(), lines: [], network: [], timeouts: [], ...over }
    boxes.set(box.sandboxId, box)
    return box
  }

  const Sandbox = {
    create: vi.fn(async (template: string, options: Record<string, unknown>) => {
      creates.push({ template, options })
      if (hooks.createError) throw hooks.createError
      const box = add(options.metadata as Record<string, string>)
      events.push(`create ${box.sandboxId}`)
      hooks.duringCreate?.()
      return instance(box)
    }),
    connect: vi.fn(async (sandboxId: string, _options: Record<string, unknown>) => {
      const box = boxes.get(sandboxId)
      if (!box) throw named('SandboxNotFoundError', `sandbox ${sandboxId} not found`)
      if (box.state === 'paused') { box.state = 'running'; events.push(`resume ${sandboxId}`) }
      events.push(`connect ${sandboxId}`)
      return instance(box)
    }),
    kill: vi.fn(async (sandboxId: string, _options?: Record<string, unknown>) => {
      events.push(`kill ${sandboxId}`)
      return boxes.delete(sandboxId)
    }),
    list: vi.fn((options: { query: { metadata?: Record<string, string>; state?: string[] } }) => {
      let done = false
      return {
        get hasNext() { return !done },
        nextItems: async () => {
          done = true
          return [...boxes.values()]
            .filter(b => Object.entries(options.query.metadata ?? {}).every(([k, v]) => b.metadata[k] === v))
            .filter(b => !options.query.state || options.query.state.includes(b.state))
            .map(b => ({ sandboxId: b.sandboxId, metadata: { ...b.metadata }, state: b.state, startedAt: b.startedAt }))
        },
      }
    }),
    getInfo: vi.fn(async (sandboxId: string) => {
      const b = boxes.get(sandboxId)
      if (!b) throw named('SandboxNotFoundError', 'not found')
      if (b.pausingFor !== undefined && --b.pausingFor <= 0) {
        b.pausingFor = undefined
        b.state = 'paused'
        b.dead = undefined
        events.push(`paused ${sandboxId}`)
      }
      return { sandboxId, metadata: { ...b.metadata }, state: b.state, startedAt: b.startedAt }
    }),
  }
  return { boxes, events, creates, hooks, Sandbox, add, words, named, reset() { boxes.clear(); events.length = 0; creates.length = 0; seq = 0; hooks.duringCreate = null; hooks.createError = null; hooks.close = 'ok' } }
})
vi.mock('@/lib/cloud-browser/runtime-client', () => ({ loadRuntimeBrowserClient: async () => ({ Sandbox: rt.Sandbox }) }))
// The hosted service is never called on this backend.
const hostedCalls = vi.hoisted(() => [] as string[])
vi.mock('@vercel/sandbox', () => {
  const refuse = (what: string) => () => { hostedCalls.push(what); throw new Error(`hosted ${what} called`) }
  return { Sandbox: { get: refuse('get'), getOrCreate: refuse('getOrCreate'), list: refuse('list') }, Snapshot: { list: refuse('snapshots'), get: refuse('snapshot') } }
})
const store = vi.hoisted(() => ({
  markStarting: vi.fn(async (_ref: unknown, _name: string) => {}),
  markRunning: vi.fn(async (_ref: unknown, _sessionId: string, _startedAt: Date) => {}),
  markStopping: vi.fn(async (_ref: unknown, _seen: unknown) => true),
  markStopped: vi.fn(async (_ref: unknown, _reason: string) => {}),
  touch: vi.fn(async () => {}),
  deleteRow: vi.fn(async (_ref: unknown) => {}),
  sandboxNamesWithRows: vi.fn(async (_names: string[]) => new Set<string>()),
  listStopCandidates: vi.fn(async () => [] as unknown[]),
  readStatus: vi.fn(async (_ref: unknown) => null as string | null),
  readSession: vi.fn(async (_ref: unknown) => null as { status: string; sessionId: string | null } | null),
  readExitMode: vi.fn(async (_ref: unknown) => null as string | null),
  recordExit: vi.fn(async () => {}),
  listUnusedStopped: vi.fn(async (_cutoff: Date, _limit: number) => [] as unknown[]),
  claimUnusedForExpiry: vi.fn(async (_ref: unknown, _at: string) => true),
  isExpiring: vi.fn(async (_ref: unknown) => false),
  deleteExpiringRow: vi.fn(async (_ref: unknown) => true),
  sessionOfSandboxName: vi.fn(async (_name: string) => null as string | null),
  recordStartingSandbox: vi.fn(async (_name: string, _sandboxId: string) => {}),
  releaseStart: vi.fn(async (_ref: unknown) => {}),
  listSlotHolders: vi.fn(async () => [] as unknown[]),
  browsersWithLiveCommands: vi.fn(async (_refs: unknown[], _now?: number) => new Set<string>()),
  countRecentEvictions: vi.fn(async (_withinMs: number, _now?: number) => 0),
  hubSessionLive: vi.fn(async (_sandboxId: string) => false),
}))
vi.mock('@/lib/cloud-browser/store', () => store)
const rings = vi.hoisted(() => [] as { ref: unknown; event: string }[])
vi.mock('@/lib/browser-agent/queue', () => ({ ringComputer: async (ref: unknown, event: string) => { rings.push({ ref, event }) } }))

const host = await import('@/lib/cloud-browser/host')
const { cloudBrowserSandboxName } = await import('@/lib/cloud-browser/ids')
const { verifyBrowserRelayToken } = await import('@/lib/cloud-browser/relay-token')
const { CloudBrowserBusyError, isCloudBrowserBusy } = await import('@/lib/cloud-browser/slots')
const { clearHubTlsCache, hubTlsAllowed } = await import('@/lib/cloud-browser/hub-tls')
const { chooseSandbox, CLOSE_USR_LOCAL, firstOf, forgetPrewarmedHubs, RUNTIME_TIMING, runtimeNetworkFor, sandboxIdOfSession, USR_LOCAL_CLOSED } = await import('@/lib/cloud-browser/backend-runtime')
rt.hooks.closeLine = CLOSE_USR_LOCAL
rt.hooks.checkLine = USR_LOCAL_CLOSED
// The waits, short: what they decide is tested, not how long they last.
Object.assign(RUNTIME_TIMING, { deadWaitMs: 60, deadPollMs: 5, probeRetryMs: 1 })

const KEY = 'e2b_secret_key_123'
const ref = { userId: 'u1', workspaceId: 'w1' }
const NAME = cloudBrowserSandboxName('u1', 'w1', 'local')
const META = { niKind: 'cloud-browser', niName: NAME, niNs: 'local' }
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16']
const SIX_HOURS = 6 * 60 * 60 * 1000

/** The hub names the ensure asked for in the background (the certificate's prewarm), and what the row said at that moment. */
const prewarms: { url: string; init: RequestInit }[] = []

beforeEach(() => {
  vi.clearAllMocks()
  rt.reset()
  hostedCalls.length = 0
  rings.length = 0
  prewarms.length = 0
  forgetPrewarmedHubs()
  vi.stubEnv('CLOUD_BROWSER_MAX_RUNNING', '')
  store.markStarting.mockImplementation(async () => {})
  store.markRunning.mockImplementation(async () => {})
  store.markStopped.mockImplementation(async () => {})
  store.touch.mockImplementation(async () => {})
  store.readStatus.mockImplementation(async () => null)
  store.readSession.mockImplementation(async () => null)
  store.recordStartingSandbox.mockImplementation(async () => {})
  store.releaseStart.mockImplementation(async () => {})
  store.listSlotHolders.mockImplementation(async () => [])
  store.browsersWithLiveCommands.mockImplementation(async () => new Set<string>())
  store.countRecentEvictions.mockImplementation(async () => 0)
  store.hubSessionLive.mockImplementation(async () => false)
  store.listStopCandidates.mockImplementation(async () => [])
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  vi.stubEnv('CLOUD_BROWSER_BACKEND', 'runtime')
  vi.stubEnv('SANDBOX_RUNTIME_API_URL', 'http://runtime.test:3000')
  vi.stubEnv('SANDBOX_RUNTIME_TRAFFIC_URL', 'http://runtime.test:3002')
  vi.stubEnv('SANDBOX_RUNTIME_KEY', KEY)
  vi.stubEnv('CLOUD_BROWSER_RUNTIME_TEMPLATE', '')
  vi.stubEnv('CLOUD_BROWSER_HUB_DOMAIN', 'hub.test')
  vi.stubEnv('CLOUD_BROWSER_BASE_SNAPSHOT_ID', '')
  vi.stubEnv('CLOUD_BROWSER_RELAY_ORIGIN', 'https://relay.test')
  vi.stubEnv('BROWSER_INTERNAL_SECRET', 'browser-secret')
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '')
  vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '')
  vi.stubEnv('CLOUD_BROWSER_SIGNING_KEY', '')
  store.markStopping.mockImplementation(async () => true)
  store.readExitMode.mockImplementation(async () => null)
  store.sessionOfSandboxName.mockImplementation(async () => null)
  store.isExpiring.mockImplementation(async () => false)
  store.claimUnusedForExpiry.mockImplementation(async () => true)
  store.deleteExpiringRow.mockImplementation(async () => true)
  // envd's health check through the traffic port (the reconcile's): a live box answers, a dead or paused one not.
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    // The hub's prewarm (no answer anyone reads: the hub is not up yet).
    if (url.endsWith('.hub.test/health')) {
      prewarms.push({ url, init: init as unknown as RequestInit })
      return new Response(null, { status: 502 })
    }
    const box = rt.boxes.get(init.headers['E2b-Sandbox-Id'])
    expect(url).toBe('http://runtime.test:3002/health')
    expect(init.headers['E2b-Sandbox-Port']).toBe('49983')
    return new Response(null, { status: box && box.state === 'running' && !box.dead ? 204 : 502 })
  }))
})

const only = () => {
  expect(rt.boxes.size).toBe(1)
  return [...rt.boxes.values()][0]
}

describe('ensure on the runtime backend', () => {
  it('creates the sandbox from the template with exactly these options, and records its run', async () => {
    const out = await host.ensureCloudBrowser(ref)
    const box = only()
    expect(rt.creates).toEqual([{
      template: 'ni-cloud-browser',
      options: {
        apiKey: KEY, apiUrl: 'http://runtime.test:3000', sandboxUrl: 'http://runtime.test:3002',
        timeoutMs: SIX_HOURS,
        metadata: META,
        // The lifetime's end pauses it (the profile stays), and no traffic wakes it.
        lifecycle: { onTimeout: 'pause', autoResume: false },
        // Nothing out until the relay's start sets the exit mode's network.
        allowInternetAccess: false,
        // Reached through our edge, which sends no traffic access token.
        network: { allowPublicTraffic: true },
      },
    }])
    expect(out).toMatchObject({ sandboxName: NAME, created: true, hubOrigin: `https://${box.sandboxId}.hub.test` })
    const [, sessionId, startedAt] = store.markRunning.mock.calls[0]
    expect(sessionId).toBe(`${box.sandboxId}.${startedAt.getTime()}`)
    expect(out.sessionId).toBe(sessionId)
    expect(store.markStarting).toHaveBeenCalledWith(ref, NAME)
    expect(hostedCalls).toEqual([])
    // start.sh and the relay detached, the rest waited for.
    const detached = box.lines.filter(l => l.detached).map(l => rt.words(l.line).slice(0, 4).join(' '))
    expect(detached).toEqual(['bash /opt/cloud-browser/start.sh', `bash -c ${rt.words(box.lines.find(l => l.line.includes('relay-start'))!.line)[2]} relay-start`])
  })

  it('opens the cloud mode’s network with the private ranges denied, and never a header rule', async () => {
    await host.ensureCloudBrowser(ref)
    const box = only()
    expect(box.network).toEqual([{ allowInternetAccess: true, denyOut: PRIVATE }])
    const sent = JSON.stringify([rt.creates, box.network])
    expect(sent).not.toMatch(/rules|transform|headers/)
  })

  it('in mac mode lets nothing out but the relay host, and an exit switch sets the other mode', async () => {
    store.readExitMode.mockResolvedValueOnce('mac')
    await host.ensureCloudBrowser(ref)
    const box = only()
    expect(box.network).toEqual([{ allowOut: ['relay.test'], denyOut: ['0.0.0.0/0'], dnsServers: ['1.1.1.1', '9.9.9.9'] }])
    await host.setExitMode(ref, 'cloud', { up: false }, 'https://browser-relay.dial8.ai')
    expect(box.network.at(-1)).toEqual({ allowInternetAccess: true, denyOut: PRIVATE })
    await host.setExitMode(ref, 'mac', { up: true }, 'https://browser-relay.dial8.ai')
    expect(box.network.at(-1)).toEqual({ allowOut: ['browser-relay.dial8.ai'], denyOut: ['0.0.0.0/0'], dnsServers: ['1.1.1.1', '9.9.9.9'] })
    expect(store.recordExit).toHaveBeenCalledWith(ref, 'mac', { up: true })
    expect(JSON.stringify(box.network)).not.toMatch(/rules|transform|headers/)
  })

  it('writes the relay token by the file API into a 0700 directory, 0600, renamed into place: never in a command line or env', async () => {
    await host.ensureCloudBrowser(ref)
    const box = only()
    const token = box.files.get('/tmp/cloud-browser-relay/secret/token')!
    // It says it is a runtime VM's: good on this backend only.
    expect(verifyBrowserRelayToken(token)).toMatchObject({ userId: 'u1', workspaceId: 'w1', sandbox: NAME, backend: 'runtime' })
    expect(box.files.has('/tmp/cloud-browser-relay/secret/token.new')).toBe(false)
    for (const { line, envs } of box.lines) {
      expect(line).not.toContain(token)
      expect(envs).toBeUndefined()
    }
    const prep = box.lines.findIndex(l => l.line.includes('mkdir -p /tmp/cloud-browser-relay/secret'))
    expect(box.lines[prep].line).toBe('umask 077 && mkdir -p /tmp/cloud-browser-relay/secret && chmod 700 /tmp/cloud-browser-relay/secret && rm -f /tmp/cloud-browser-relay/secret/token.new')
    expect(box.lines[prep + 1].line).toBe('chmod 600 /tmp/cloud-browser-relay/secret/token.new && mv -f /tmp/cloud-browser-relay/secret/token.new /tmp/cloud-browser-relay/secret/token && echo ok')
    // The token's directory is made before the file is written, the network set after.
    const order = rt.events.filter(e => e.startsWith('write') || e.startsWith('network') || /^run \S+ (umask 077 && mkdir|chmod 600)/.test(e))
    expect(order.map(e => e.split(' ')[0])).toEqual(['run', 'write', 'run', 'network'])
    // The relay is told where the file is, never what is in it.
    const start = rt.words(box.lines.find(l => l.line.includes('relay-start'))!.line)
    expect(start.slice(3)).toEqual(['relay-start', 'https://relay.test', 'dev', '/tmp/cloud-browser-relay', '4000', NAME, '', 'cloud', '/tmp/cloud-browser-relay/secret/token', 'x-real-ip'])
    // An exit switch writes a fresh one the same way.
    await new Promise(resolve => setTimeout(resolve, 2))
    await host.setExitMode(ref, 'mac', { up: true })
    const fresh = box.files.get('/tmp/cloud-browser-relay/secret/token')!
    expect(verifyBrowserRelayToken(fresh)).not.toBeNull()
    for (const { line } of box.lines) expect(line).not.toContain(fresh)
  })

  it('wakes a paused sandbox with connect, gives it a whole lifetime, and starts a new run', async () => {
    const box = rt.add(META, { state: 'paused', runStart: '1700000000000' })
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(false)
    expect(rt.events.slice(0, 2)).toEqual([`resume ${box.sandboxId}`, `connect ${box.sandboxId}`])
    expect(rt.Sandbox.connect).toHaveBeenCalledWith(box.sandboxId, expect.objectContaining({ timeoutMs: SIX_HOURS, apiKey: KEY }))
    expect(box.timeouts).toEqual([SIX_HOURS])
    expect(box.runStart).not.toBe('1700000000000')
    expect(out.sessionId).toBe(`${box.sandboxId}.${box.runStart}`)
    expect(rt.Sandbox.create).not.toHaveBeenCalled()
  })

  it('reuses a running sandbox, and every ensure of one run records the same session', async () => {
    const first = await host.ensureCloudBrowser(ref)
    const second = await host.ensureCloudBrowser(ref)
    expect(second).toMatchObject({ created: false, sessionId: first.sessionId })
    expect(only().timeouts).toEqual([])
  })

  it('a sandbox STILL silent after the whole wait is neither killed nor bypassed: a retry error, one log line, nothing created', async () => {
    const dead = rt.add(META, { dead: 'not-running', startedAt: new Date(0) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow('cloud browser: your browser is not answering yet; try again in a minute')
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
    expect(rt.Sandbox.create).not.toHaveBeenCalled()
    expect(rt.boxes.has(dead.sandboxId)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warn.mock.calls[0][1] as string)
    expect(logged).toMatchObject({ name: NAME, sandboxId: dead.sandboxId, state: 'running', startedAt: new Date(0).toISOString() })
  })

  it('repeated ensures against a silent sandbox never create anything', async () => {
    rt.add(META, { dead: 'not-running' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 4; i++) await expect(host.ensureCloudBrowser(ref)).rejects.toThrow(/not answering yet/)
    expect(rt.Sandbox.create).not.toHaveBeenCalled()
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
    expect(rt.boxes.size).toBe(1)
  })

  it('the reviewer’s case: a pause outlasting the wait ends in the retry error; once it lands, the next ensure wakes THAT sandbox, profile and all', async () => {
    const box = rt.add(META, { dead: 'not-running', pausingFor: 10_000, runStart: '1700000000005' })
    box.files.set('/home/user/profile/Default/Cookies', 'the sign-ins')
    store.sessionOfSandboxName.mockResolvedValue(`${box.sandboxId}.1700000000005`)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow(/not answering yet; try again/)
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
    expect(rt.Sandbox.create).not.toHaveBeenCalled()
    // Its pause lands.
    box.pausingFor = undefined
    box.state = 'paused'
    box.dead = undefined
    const again = await host.ensureCloudBrowser(ref)
    expect(again).toMatchObject({ created: false, hubOrigin: `https://${box.sandboxId}.hub.test` })
    expect(rt.events).toContain(`resume ${box.sandboxId}`)
    expect(only().files.get('/home/user/profile/Default/Cookies')).toBe('the sign-ins')
  })

  it('two paused copies: the row’s is woken whatever its age; with no row id, the NEWEST', async () => {
    const old = rt.add(META, { state: 'paused', startedAt: new Date(Date.now() - 21 * 24 * 3600_000) })
    const recent = rt.add(META, { state: 'paused', startedAt: new Date(Date.now() - 3600_000) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await host.ensureCloudBrowser(ref)).hubOrigin).toBe(`https://${recent.sandboxId}.hub.test`)
    expect(old.state).toBe('paused')
    recent.state = 'paused'
    store.sessionOfSandboxName.mockResolvedValue(`${old.sandboxId}.1`)
    expect((await host.ensureCloudBrowser(ref)).hubOrigin).toBe(`https://${old.sandboxId}.hub.test`)
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
  })

  it('a sandbox being paused (listed running, not answering) is never killed: it is woken once its pause lands', async () => {
    // The sweep or the server's pause unit is pausing it; the runtime still lists it running for a while.
    const box = rt.add(META, { dead: 'not-running', pausingFor: 3, runStart: '1700000000004' })
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(false)
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
    expect(rt.Sandbox.create).not.toHaveBeenCalled()
    expect(rt.boxes.has(box.sandboxId)).toBe(true)
    expect(rt.events).toContain(`paused ${box.sandboxId}`)
    expect(rt.events).toContain(`resume ${box.sandboxId}`)
    expect(out.hubOrigin).toBe(`https://${box.sandboxId}.hub.test`)
  })

  it('a silent sandbox that comes back with another start is an error to retry, never a kill', async () => {
    const box = rt.add(META, { dead: 'not-running' })
    const real = rt.Sandbox.getInfo.getMockImplementation()!
    rt.Sandbox.getInfo.mockImplementationOnce(async (id: string) => ({ ...(await real(id)), startedAt: new Date(box.startedAt.getTime() + 1) }))
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow(/changed while starting; try again/)
    expect(rt.boxes.has(box.sandboxId)).toBe(true)
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
  })

  it('a silent sandbox that is gone by the next look is replaced without a kill', async () => {
    const box = rt.add(META, { dead: 'not-running' })
    rt.Sandbox.getInfo.mockImplementationOnce(async () => { rt.boxes.delete(box.sandboxId); throw rt.named('SandboxNotFoundError', 'gone') })
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(true)
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
  })

  it('never kills a running sandbox it merely could not reach: the ensure fails instead', async () => {
    const box = rt.add(META, { dead: 'unreachable' })
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow(/could not reach sandbox/)
    expect(rt.boxes.has(box.sandboxId)).toBe(true)
    expect(rt.Sandbox.create).not.toHaveBeenCalled()
  })

  it('after a create, a sandbox someone may own (an old one) wins: only MINE is killed', async () => {
    let theirs = ''
    rt.hooks.duringCreate = () => {
      rt.hooks.duringCreate = null
      const other = rt.add(META, { startedAt: new Date(0), runStart: '1700000000000' })
      theirs = other.sandboxId
    }
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(false)
    expect(only().sandboxId).toBe(theirs)
    expect(out.sessionId).toBe(`${theirs}.1700000000000`)
    expect(rt.Sandbox.kill).toHaveBeenCalledTimes(1)
    expect(rt.Sandbox.kill).not.toHaveBeenCalledWith(theirs, expect.anything())
  })

  it('after a create, a PAUSED sandbox for the name (a profile mid-resume missed by the first list) wins and is woken, even a fresh one', async () => {
    let theirs = ''
    rt.hooks.duringCreate = () => {
      rt.hooks.duringCreate = null
      theirs = rt.add(META, { state: 'paused', startedAt: new Date(Date.now() + 60_000) }).sandboxId
    }
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(false)
    expect(only().sandboxId).toBe(theirs)
    expect(rt.events).toContain(`resume ${theirs}`)
  })

  it('after a create, the sandbox the row names wins, however fresh', async () => {
    let theirs = ''
    rt.hooks.duringCreate = () => {
      rt.hooks.duringCreate = null
      theirs = rt.add(META, { startedAt: new Date(Date.now() + 60_000), runStart: '1700000000001' }).sandboxId
      store.sessionOfSandboxName.mockResolvedValue(`${theirs}.1700000000001`)
    }
    const out = await host.ensureCloudBrowser(ref)
    expect(out).toMatchObject({ created: false, sessionId: `${theirs}.1700000000001` })
    expect(only().sandboxId).toBe(theirs)
  })

  it('two racing creates, both fresh and unnamed: the larger id kills ITSELF only (mine larger)', async () => {
    rt.hooks.duringCreate = () => {
      rt.hooks.duringCreate = null
      rt.add(META, { sandboxId: 'sbx0', startedAt: new Date(Date.now() + 1), runStart: '1700000000002' })
    }
    const out = await host.ensureCloudBrowser(ref)
    expect(out).toMatchObject({ created: false, sessionId: 'sbx0.1700000000002' })
    expect(only().sandboxId).toBe('sbx0')
    expect(rt.Sandbox.kill.mock.calls.map(c => c[0])).toEqual(['sbx1'])
  })

  it('… (mine smaller): mine stays and the other is left for its own caller to remove', async () => {
    rt.hooks.duringCreate = () => {
      rt.hooks.duringCreate = null
      rt.add(META, { sandboxId: 'sbx9', startedAt: new Date(Date.now() - 1_000) })
    }
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(true)
    expect(out.hubOrigin).toBe('https://sbx1.hub.test')
    expect(rt.boxes.has('sbx9')).toBe(true)
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
  })

  it('finding more than one, an ensure kills none of them: the row’s, else the paused, else the oldest is used', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const older = rt.add(META, { startedAt: new Date(1_000) })
    const paused = rt.add(META, { state: 'paused', startedAt: new Date(5_000) })
    const named = rt.add(META, { startedAt: new Date(9_000), runStart: '1700000000003' })
    store.sessionOfSandboxName.mockResolvedValue(`${named.sandboxId}.1700000000003`)
    expect((await host.ensureCloudBrowser(ref)).sessionId).toBe(`${named.sandboxId}.1700000000003`)
    store.sessionOfSandboxName.mockResolvedValue(null)
    const out = await host.ensureCloudBrowser(ref)
    expect(out.hubOrigin).toBe(`https://${paused.sandboxId}.hub.test`)
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
    expect(rt.boxes.size).toBe(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('more than one runtime sandbox'), expect.stringContaining(older.sandboxId))
    expect(chooseSandbox([older, named].map(b => ({ ...b })), null)?.sandboxId).toBe(older.sandboxId)
  })

  it('the order that decides is the same for every caller: oldest start, then the smaller id', () => {
    const at = new Date(5)
    expect(firstOf([{ sandboxId: 'b', metadata: {}, state: 'running', startedAt: at }, { sandboxId: 'a', metadata: {}, state: 'running', startedAt: at }])?.sandboxId).toBe('a')
    expect(firstOf([{ sandboxId: 'a', metadata: {}, state: 'running', startedAt: new Date(9) }, { sandboxId: 'b', metadata: {}, state: 'paused', startedAt: at }])?.sandboxId).toBe('b')
    expect(firstOf([])).toBeNull()
  })

  it('ignores sandboxes of another browser, kind or database', async () => {
    rt.add({ ...META, niName: 'browser-local-other' })
    rt.add({ ...META, niNs: 'otherdb' })
    rt.add({ ...META, niKind: 'coding-agent' })
    expect((await host.ensureCloudBrowser(ref)).created).toBe(true)
    expect(rt.boxes.size).toBe(4)
  })

  it('never puts the key in an error', async () => {
    rt.hooks.createError = new Error(`401: invalid key ${KEY}`)
    const failed = await host.ensureCloudBrowser(ref).then(() => null, (e: Error) => e)
    expect(failed?.message).toContain('[redacted]')
    expect(failed?.message).not.toContain(KEY)
  })

  it('needs every runtime setting, names the missing ones (never a value), and never falls back to the hosted service', async () => {
    vi.stubEnv('SANDBOX_RUNTIME_KEY', '')
    vi.stubEnv('CLOUD_BROWSER_HUB_DOMAIN', '')
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow('SANDBOX_RUNTIME_KEY, CLOUD_BROWSER_HUB_DOMAIN not set')
    expect(hostedCalls).toEqual([])
    expect(rt.Sandbox.list).not.toHaveBeenCalled()
    // No base snapshot is needed on this backend.
    vi.stubEnv('SANDBOX_RUNTIME_KEY', KEY)
    vi.stubEnv('CLOUD_BROWSER_HUB_DOMAIN', 'hub.test')
    await expect(host.ensureCloudBrowser(ref)).resolves.toMatchObject({ created: true })
  })

  it('creates from CLOUD_BROWSER_RUNTIME_TEMPLATE when it is set', async () => {
    vi.stubEnv('CLOUD_BROWSER_RUNTIME_TEMPLATE', 'ni-cloud-browser-v2')
    await host.ensureCloudBrowser(ref)
    expect(rt.creates[0].template).toBe('ni-cloud-browser-v2')
  })
})

describe('stop and delete on the runtime backend', () => {
  it('runs stop.sh before the pause', async () => {
    const box = rt.add(META)
    expect(await host.stopCloudBrowser(ref, 'idle')).toBe('stopped')
    const stopAt = rt.events.findIndex(e => e.includes('/opt/cloud-browser/stop.sh'))
    expect(stopAt).toBeGreaterThan(-1)
    expect(rt.events.indexOf(`pause ${box.sandboxId}`)).toBeGreaterThan(stopAt)
    expect(box.state).toBe('paused')
    expect(rt.boxes.has(box.sandboxId)).toBe(true)
    // The row keeps naming the sandbox its profile is in.
    expect(store.markStopped).toHaveBeenCalledWith(ref, 'idle', { keepSession: true })
  })

  it('never wakes a paused sandbox to stop it, and records a missing one', async () => {
    rt.add(META, { state: 'paused' })
    expect(await host.stopCloudBrowser(ref, 'idle')).toBe('already_stopped')
    expect(rt.Sandbox.connect).not.toHaveBeenCalled()
    rt.reset()
    expect(await host.stopCloudBrowser(ref, 'requested')).toBe('missing')
  })

  it('an exit switch on a browser that is not running is refused, without waking it', async () => {
    rt.add(META, { state: 'paused' })
    await expect(host.setExitMode(ref, 'mac', { up: true })).rejects.toThrow('cloud browser not running')
    expect(rt.Sandbox.connect).not.toHaveBeenCalled()
  })

  it('destroys every sandbox of the name ("not found" is done), then the row', async () => {
    const a = rt.add(META)
    const b = rt.add(META, { state: 'paused' })
    const keep = rt.add({ ...META, niName: 'browser-local-other' })
    rt.Sandbox.kill.mockImplementationOnce(async () => { throw rt.named('SandboxNotFoundError', 'gone') })
    expect(await host.deleteCloudBrowser(ref)).toEqual({ snapshotsDeleted: 0 })
    expect(rt.Sandbox.kill).toHaveBeenCalledWith(a.sandboxId, expect.anything())
    expect(rt.Sandbox.kill).toHaveBeenCalledWith(b.sandboxId, expect.anything())
    // Every call of a destroy is bounded (the expiry's claim outlasts it).
    for (const [, options] of rt.Sandbox.kill.mock.calls) expect(options).toMatchObject({ requestTimeoutMs: 15_000 })
    expect(rt.Sandbox.list.mock.calls.at(-1)![0]).toMatchObject({ requestTimeoutMs: 15_000 })
    expect(rt.boxes.has(keep.sandboxId)).toBe(true)
    expect(store.deleteRow).toHaveBeenCalledWith(ref)
  })
})

describe('the hub on the runtime backend', () => {
  it('is read from the row alone, never from the runtime, so a recreated browser never shows a stale one', async () => {
    store.readSession.mockResolvedValueOnce({ status: 'running', sessionId: 'abc123.1700000000000' })
    expect(await host.runningHubOrigin(ref)).toBe('https://abc123.hub.test')
    store.readSession.mockResolvedValueOnce({ status: 'stopped', sessionId: null })
    expect(await host.runningHubOrigin(ref)).toBeNull()
    store.readSession.mockResolvedValueOnce({ status: 'running', sessionId: 'sbx_session_1' })
    expect(await host.runningHubOrigin(ref)).toBeNull()
    expect(rt.Sandbox.list).not.toHaveBeenCalled()
    expect(sandboxIdOfSession('x.1')).toBe('x')
  })

})

describe('the reconcile on the runtime backend', () => {
  it('removes this database’s browser sandboxes no row owns, and browsers unused past the profile’s lifetime', async () => {
    const owned = rt.add(META)
    const orphanName = cloudBrowserSandboxName('u9', 'w9', 'local')
    const orphan = rt.add({ ...META, niName: orphanName })
    const otherDb = rt.add({ ...META, niName: 'browser-otherdb-x', niNs: 'otherdb' })
    const oldName = cloudBrowserSandboxName('u7', 'w7', 'local')
    const old = rt.add({ ...META, niName: oldName }, { state: 'paused' })
    store.sandboxNamesWithRows.mockResolvedValueOnce(new Set([NAME, oldName]))
    const now = Date.parse('2027-03-01T00:00:00Z')
    store.listUnusedStopped.mockResolvedValueOnce([{ user_id: 'u7', workspace_id: 'w7', sandbox_name: oldName, status: 'stopped', last_active_at: '2026-12-01T00:00:00.000Z' }])
    expect(await host.reconcileCloudBrowsers(now)).toEqual({ orphans: 1, snapshotsDeleted: 0, expired: 1, duplicates: [], silent: [] })
    expect(store.sandboxNamesWithRows).toHaveBeenCalledWith([NAME, oldName, orphanName].sort())
    expect(rt.boxes.has(orphan.sandboxId)).toBe(false)
    expect(rt.boxes.has(owned.sandboxId)).toBe(true)
    expect(rt.boxes.has(otherDb.sandboxId)).toBe(true)
    // Unused for 60 days: claimed first (only if still untouched), then its VM, then its row.
    const [cutoff, limit] = store.listUnusedStopped.mock.calls[0]
    expect(cutoff.toISOString()).toBe(new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString())
    expect(limit).toBe(50)
    expect(rt.boxes.has(old.sandboxId)).toBe(false)
    expect(store.claimUnusedForExpiry).toHaveBeenCalledWith({ userId: 'u7', workspaceId: 'w7' }, '2026-12-01T00:00:00.000Z')
    expect(store.deleteExpiringRow).toHaveBeenCalledWith({ userId: 'u7', workspaceId: 'w7' })
  })

  it('keeps going past one expiry that fails, and counts only the rows it removed', async () => {
    store.listUnusedStopped.mockResolvedValueOnce([
      { user_id: 'u7', workspace_id: 'w7', sandbox_name: 'browser-local-a', status: 'stopped', last_active_at: 't1' },
      { user_id: 'u8', workspace_id: 'w8', sandbox_name: 'browser-local-b', status: 'stopped', last_active_at: 't2' },
      { user_id: 'u9', workspace_id: 'w9', sandbox_name: 'browser-local-c', status: 'stopped', last_active_at: 't3' },
    ])
    rt.add({ ...META, niName: 'browser-local-a' })
    rt.Sandbox.kill.mockImplementationOnce(async () => { throw new Error('runtime down') })
    store.deleteExpiringRow.mockResolvedValueOnce(false) // u8: the sweep's stuck-stopping retry took the claim back
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.sandboxNamesWithRows.mockResolvedValueOnce(new Set(['browser-local-a']))
    expect(await host.reconcileCloudBrowsers()).toMatchObject({ expired: 1 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(store.deleteExpiringRow).toHaveBeenCalledTimes(2)
  })

  it('the expiry race: a person who came back between the list and the claim keeps their profile (no kill)', async () => {
    const oldName = cloudBrowserSandboxName('u7', 'w7', 'local')
    const live = rt.add({ ...META, niName: oldName })
    store.sandboxNamesWithRows.mockResolvedValueOnce(new Set([oldName]))
    store.listUnusedStopped.mockResolvedValueOnce([{ user_id: 'u7', workspace_id: 'w7', sandbox_name: oldName, status: 'stopped', last_active_at: 't1' }])
    // Their ensure moved the row off `stopped` (markStarting): the compare-and-set fails.
    store.claimUnusedForExpiry.mockResolvedValueOnce(false)
    expect(await host.reconcileCloudBrowsers()).toMatchObject({ expired: 0 })
    expect(rt.boxes.has(live.sandboxId)).toBe(true)
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
    expect(store.deleteExpiringRow).not.toHaveBeenCalled()
  })

  it('… and an ensure that meets a claim fails with a message to retry, touching no sandbox', async () => {
    rt.add(META, { state: 'paused' })
    store.isExpiring.mockResolvedValueOnce(true)
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow(/being cleared after long disuse; try again/)
    expect(rt.Sandbox.list).not.toHaveBeenCalled()
    expect(rt.Sandbox.connect).not.toHaveBeenCalled()
  })

  it('reports `duplicates` and `silent` with what a person needs, and removes neither', async () => {
    const a = rt.add(META, { startedAt: new Date('2026-11-01T00:00:00Z') })
    const b = rt.add(META, { state: 'paused', startedAt: new Date('2026-11-10T00:00:00Z') })
    const otherName = cloudBrowserSandboxName('u2', 'w2', 'local')
    const dead = rt.add({ ...META, niName: otherName }, { dead: 'not-running', startedAt: new Date('2026-11-12T00:00:00Z') })
    store.sandboxNamesWithRows.mockResolvedValueOnce(new Set([NAME, otherName]))
    store.sessionOfSandboxName.mockImplementation(async (n: string) => (n === NAME ? `${b.sandboxId}.0` : null))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await host.reconcileCloudBrowsers()
    expect(out.duplicates).toEqual([{ name: NAME, rowSandboxId: b.sandboxId, sandboxes: [
      { sandboxId: a.sandboxId, state: 'running', startedAt: '2026-11-01T00:00:00.000Z' },
      { sandboxId: b.sandboxId, state: 'paused', startedAt: '2026-11-10T00:00:00.000Z' },
    ] }])
    expect(out.silent).toEqual([{ name: otherName, rowSandboxId: null, silentIds: [dead.sandboxId],
      sandboxes: [{ sandboxId: dead.sandboxId, state: 'running', startedAt: '2026-11-12T00:00:00.000Z' }] }])
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
    expect(rt.boxes.size).toBe(3)
    // One line per item; a paused copy is never probed (fetch only for the running ones), so never woken.
    expect(warn).toHaveBeenCalledTimes(2)
    expect((fetch as unknown as { mock: { calls: [string, { headers: Record<string, string> }][] } }).mock.calls.map(c => c[1].headers['E2b-Sandbox-Id']).sort()).toEqual([a.sandboxId, dead.sandboxId].sort())
    expect(rt.Sandbox.connect).not.toHaveBeenCalled()
    expect(b.state).toBe('paused')
  })

  it('probes at most the bound per run', async () => {
    const names = Array.from({ length: 25 }, (_, i) => cloudBrowserSandboxName(`p${i}`, 'w', 'local'))
    for (const n of names) rt.add({ ...META, niName: n }, { dead: 'not-running' })
    store.sandboxNamesWithRows.mockResolvedValueOnce(new Set(names))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await host.reconcileCloudBrowsers()
    expect(out.silent).toHaveLength(20)
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(20)
  })

  it('the operator’s row edit (a stopped row’s session_id set to `<id>.0`) makes the next ensure wake that copy', async () => {
    const newer = rt.add(META, { state: 'paused', startedAt: new Date(Date.now() - 3600_000) })
    const wanted = rt.add(META, { state: 'paused', startedAt: new Date(Date.now() - 7 * 24 * 3600_000) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.sessionOfSandboxName.mockResolvedValue(`${wanted.sandboxId}.0`)
    const out = await host.ensureCloudBrowser(ref)
    expect(out.hubOrigin).toBe(`https://${wanted.sandboxId}.hub.test`)
    expect(rt.events).toContain(`resume ${wanted.sandboxId}`)
    expect(newer.state).toBe('paused')
    // The ensure records a real session for it.
    expect(store.markRunning.mock.calls[0][1]).toMatch(new RegExp(`^${wanted.sandboxId}\\.\\d{13}$`))
    expect(sandboxIdOfSession(`${wanted.sandboxId}.0`)).toBe(wanted.sandboxId)
  })
})

describe('runtimeNetworkFor', () => {
  it('maps the two modes, a relay origin with a port or path to its host name', () => {
    expect(runtimeNetworkFor('mac', 'https://browser-relay.nativeintelligence.dev:443/x')).toEqual({ allowOut: ['browser-relay.nativeintelligence.dev'], denyOut: ['0.0.0.0/0'], dnsServers: ['1.1.1.1', '9.9.9.9'] })
    expect(runtimeNetworkFor('cloud', 'https://r.test')).toEqual({ allowInternetAccess: true, denyOut: PRIVATE })
  })
})

describe('the image’s resolvers', () => {
  // deploy/sandbox/image.py writes them into the image's /etc/resolv.conf; mac mode opens exactly them.
  const image = resolve(__dirname, '../../../../../deploy/sandbox/image.py')
  it.skipIf(!existsSync(image))('are the ones deploy/sandbox/image.py writes into the image', async () => {
    const { CLOUD_BROWSER_IMAGE_RESOLVERS } = await import('@/lib/cloud-browser/config')
    const listed = /^RESOLVERS = \[([^\]]*)\]$/m.exec(readFileSync(image, 'utf8'))?.[1]
    expect(listed, 'RESOLVERS in deploy/sandbox/image.py').toBeDefined()
    expect([...listed!.matchAll(/"([^"]+)"/g)].map(m => m[1])).toEqual([...CLOUD_BROWSER_IMAGE_RESOLVERS])
    expect(runtimeNetworkFor('mac', 'https://r.test').dnsServers).toEqual([...CLOUD_BROWSER_IMAGE_RESOLVERS])
    // cloud mode holds no domain, so the runtime opens no resolver for it: none is sent.
    expect(runtimeNetworkFor('cloud', 'https://r.test')).not.toHaveProperty('dnsServers')
  })
})

describe('the one root step: /usr/local closed on every new sandbox', () => {
  it('runs as root, first, before start.sh, and is the only command that ever runs as root', async () => {
    await host.ensureCloudBrowser(ref)
    const box = only()
    expect(box.lines[0]).toMatchObject({ line: CLOSE_USR_LOCAL, user: 'root' })
    expect(box.lines.filter(l => l.user === 'root').map(l => l.line)).toEqual([CLOSE_USR_LOCAL])
    const startAt = box.lines.findIndex(l => l.line.includes('/opt/cloud-browser/start.sh'))
    expect(startAt).toBeGreaterThan(0)
    // The symlink test FIRST: chown and chmod follow a link given on their command line.
    expect(CLOSE_USR_LOCAL.split(' && ').slice(0, 3)).toEqual(['test ! -L /usr/local', 'chown -R -h root:root /usr/local', 'chmod -R go-w /usr/local'])
    // A dangling link (or one readlink cannot resolve) counts as open.
    expect(CLOSE_USR_LOCAL).toContain(`t=$(readlink -f "$1") && [ -e "$t" ] && [ "$(stat -c %u "$t")" = 0 ] && [ $(( 0$(stat -c %a "$t") & 022 )) = 0 ] || echo "$1"`)
    expect(CLOSE_USR_LOCAL).toMatch(/&& echo closed$/)
  })

  it.each(['throw', 'open'] as const)('a step that %s kills THAT new sandbox and fails the ensure, before start.sh', async (how) => {
    rt.hooks.close = how
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow(/\/usr\/local in the new sandbox sbx1/)
    expect(rt.Sandbox.kill.mock.calls.map(c => c[0])).toEqual(['sbx1'])
    expect(rt.boxes.size).toBe(0)
    expect(store.markRunning).not.toHaveBeenCalled()
    expect(rt.events.some(e => e.includes('/opt/cloud-browser/start.sh'))).toBe(false)
  })

  it('a wake runs no root command and never kills, even when the step would fail', async () => {
    const box = rt.add(META, { state: 'paused' })
    rt.hooks.close = 'throw'
    expect((await host.ensureCloudBrowser(ref)).created).toBe(false)
    expect(box.lines.some(l => l.user === 'root')).toBe(false)
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
    // A running one reused: the same.
    expect((await host.ensureCloudBrowser(ref)).created).toBe(false)
    expect(box.lines.some(l => l.user === 'root')).toBe(false)
  })

  it('a take-up only checks, as the template’s user; a create that gives way runs no root step in the other', async () => {
    let theirs = ''
    rt.hooks.duringCreate = () => {
      rt.hooks.duringCreate = null
      theirs = rt.add(META, { startedAt: new Date(0) }).sandboxId
    }
    await host.ensureCloudBrowser(ref)
    const lines = rt.boxes.get(theirs)!.lines
    expect(lines.some(l => l.user === 'root')).toBe(false)
    expect(lines.find(l => l.line === USR_LOCAL_CLOSED)).toMatchObject({ line: USR_LOCAL_CLOSED })
    expect(lines.find(l => l.line === USR_LOCAL_CLOSED)!.user).toBeUndefined()
  })

  it('a sandbox taken up with /usr/local open (its own step never ran) is closed as root, never killed', async () => {
    const box = rt.add(META, { state: 'paused', usrLocalOpen: true })
    expect((await host.ensureCloudBrowser(ref)).created).toBe(false)
    expect(box.lines.filter(l => l.user === 'root').map(l => l.line)).toEqual([CLOSE_USR_LOCAL])
    expect(box.usrLocalOpen).toBe(false)
    // Closed before start.sh.
    expect(box.lines.findIndex(l => l.user === 'root')).toBeLessThan(box.lines.findIndex(l => l.line.includes('/opt/cloud-browser/start.sh')))
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
  })

  it('… and one that cannot be closed fails the ensure (to retry), still never killed', async () => {
    const box = rt.add(META, { usrLocalOpen: true })
    rt.hooks.close = 'open'
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow(/could not be closed; try again/)
    expect(rt.boxes.has(box.sandboxId)).toBe(true)
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
    expect(box.lines.some(l => l.line.includes('/opt/cloud-browser/start.sh'))).toBe(false)
  })
})

// ── The shared slots and the hub's prewarm, against rows kept in memory ─────

interface TableRow {
  user_id: string; workspace_id: string; sandbox_name: string; session_id: string | null
  status: 'starting' | 'running' | 'stopping' | 'stopped'; started_at: string | null
  last_active_at: string; updated_at: string; stop_reason: string | null
}
const table = new Map<string, TableRow>()
const keyOf = (r: { userId: string; workspaceId: string }) => `${r.userId}:${r.workspaceId}`
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

/** The row store's rules, as store.ts writes them, on the rows above (the compare-and-sets included). */
function useTable() {
  table.clear()
  const set = (row: TableRow, patch: Partial<TableRow>) => Object.assign(row, patch, { updated_at: new Date().toISOString() })
  store.markStarting.mockImplementation(async (r: unknown, name: string) => {
    const k = keyOf(r as { userId: string; workspaceId: string })
    const now = new Date().toISOString()
    const [userId, workspaceId] = k.split(':')
    if (!table.has(k)) table.set(k, { user_id: userId, workspace_id: workspaceId, sandbox_name: name, session_id: null, status: 'starting', started_at: null, last_active_at: now, updated_at: now, stop_reason: null })
    const row = table.get(k)!
    if (row.status === 'stopped') set(row, { status: 'starting', stop_reason: null })
    set(row, { last_active_at: now })
  })
  store.readStatus.mockImplementation(async (r: unknown) => table.get(keyOf(r as never))?.status ?? null)
  store.readSession.mockImplementation(async (r: unknown) => {
    const row = table.get(keyOf(r as never))
    return row ? { status: row.status, sessionId: row.session_id } : null
  })
  store.markRunning.mockImplementation(async (r: unknown, sessionId: string, startedAt: Date) => {
    const row = table.get(keyOf(r as never))!
    set(row, { status: 'running', session_id: sessionId, started_at: startedAt.toISOString(), last_active_at: new Date().toISOString() })
  })
  store.touch.mockImplementation(async (r?: unknown) => {
    const row = table.get(keyOf(r as never))
    if (row && (row.status === 'starting' || row.status === 'running')) set(row, { last_active_at: new Date().toISOString() })
  })
  store.markStopping.mockImplementation(async (r: unknown, seen: unknown) => {
    const row = table.get(keyOf(r as never))
    const s = seen as TableRow & { reason: string } | null
    if (!row) return false
    if (!s) { if (row.status === 'stopped') return false; set(row, { status: 'stopping' }); return true }
    if (row.status !== s.status || row.last_active_at !== s.last_active_at) return false
    set(row, { status: 'stopping' })
    return true
  })
  store.markStopped.mockImplementation(async (r: unknown, reason: string) => {
    const row = table.get(keyOf(r as never))
    if (row?.status === 'stopping') set(row, { status: 'stopped', stop_reason: reason })
  })
  store.releaseStart.mockImplementation(async (r: unknown) => {
    const row = table.get(keyOf(r as never))
    if (row?.status === 'starting') set(row, { status: 'stopped', stop_reason: 'busy' })
  })
  store.listSlotHolders.mockImplementation(async () => [...table.values()]
    .filter(row => ['starting', 'running', 'stopping'].includes(row.status) && !(row.status === 'stopping' && row.stop_reason === 'expiring'))
    .sort((a, b) => Date.parse(a.last_active_at) - Date.parse(b.last_active_at)).map(row => ({ ...row })))
  store.sessionOfSandboxName.mockImplementation(async (n: string) => [...table.values()].find(row => row.sandbox_name === n)?.session_id ?? null)
  store.recordStartingSandbox.mockImplementation(async (n: string, id: string) => {
    const row = [...table.values()].find(r => r.sandbox_name === n)
    if (row?.status === 'starting') set(row, { session_id: `${id}.0` })
  })
  store.hubSessionLive.mockImplementation(async (id: string) => [...table.values()]
    .some(row => (row.status === 'starting' || row.status === 'running') && !!row.session_id?.startsWith(`${id}.`)))
}

/** Another person's browser, running (its sandbox too), last used `idleMs` ago. */
function runningBrowser(n: number, idleMs: number) {
  const name = cloudBrowserSandboxName(`p${n}`, `w${n}`, 'local')
  const box = rt.add({ ...META, niName: name }, { runStart: '1700000000000' })
  table.set(`p${n}:w${n}`, { user_id: `p${n}`, workspace_id: `w${n}`, sandbox_name: name, session_id: `${box.sandboxId}.1700000000000`,
    status: 'running', started_at: iso(idleMs + 1000), last_active_at: iso(idleMs), updated_at: iso(idleMs), stop_reason: null })
  return { ref: { userId: `p${n}`, workspaceId: `w${n}` }, box, row: () => table.get(`p${n}:w${n}`)! }
}
const runningBoxes = () => [...rt.boxes.values()].filter(b => b.state === 'running').length

describe('the shared slots (runtime backend)', () => {
  beforeEach(() => useTable())

  it('under the cap: the browser starts and nobody gives way', async () => {
    for (let i = 1; i <= 3; i++) runningBrowser(i, 30 * 60_000)
    expect((await host.ensureCloudBrowser(ref)).created).toBe(true)
    expect(rt.events.filter(e => e.startsWith('pause'))).toEqual([])
    expect(runningBoxes()).toBe(4)
  })

  it('at the cap: the browser idle longest is paused gracefully (stop.sh, then the pause, reason `evicted`, the Mac told), and the newcomer takes its slot', async () => {
    const others = [runningBrowser(1, 10 * 60_000), runningBrowser(2, 40 * 60_000), runningBrowser(3, 20 * 60_000), runningBrowser(4, 3 * 60_000)]
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(true)
    const victim = others[1]
    expect(victim.box.state).toBe('paused')
    expect(rt.boxes.has(victim.box.sandboxId)).toBe(true) // paused, never removed: the profile stays
    const stopAt = rt.events.indexOf(`run ${victim.box.sandboxId} 'bash' '/opt/cloud-browser/stop.sh'`)
    expect(stopAt).toBeGreaterThan(-1)
    expect(rt.events.indexOf(`pause ${victim.box.sandboxId}`)).toBeGreaterThan(stopAt)
    // The eviction finished before the newcomer's sandbox was created.
    expect(rt.events.indexOf(`pause ${victim.box.sandboxId}`)).toBeLessThan(rt.events.findIndex(e => e.startsWith('create')))
    expect(victim.row()).toMatchObject({ status: 'stopped', stop_reason: 'evicted', session_id: `${victim.box.sandboxId}.1700000000000` })
    expect(store.markStopped).toHaveBeenCalledWith(victim.ref, 'evicted', { keepSession: true })
    expect(rings).toContainEqual({ ref: victim.ref, event: 'browser-down' })
    for (const other of [others[0], others[2], others[3]]) expect(other.box.state).toBe('running')
    expect(runningBoxes()).toBe(4)
    expect(info).toHaveBeenCalledWith(expect.stringContaining('gave its slot away'), expect.stringContaining('"outcome":"stopped"'))
    // Its owner loses nothing: their next use wakes the same sandbox.
    for (const other of [others[0], others[2], others[3]]) other.row().last_active_at = iso(30 * 60_000)
    const back = await host.ensureCloudBrowser(victim.ref)
    expect(back).toMatchObject({ created: false, hubOrigin: `https://${victim.box.sandboxId}.hub.test` })
    expect(rt.events).toContain(`resume ${victim.box.sandboxId}`)
  })

  it('reads the cap from CLOUD_BROWSER_MAX_RUNNING', async () => {
    vi.stubEnv('CLOUD_BROWSER_MAX_RUNNING', '2')
    const a = runningBrowser(1, 10 * 60_000)
    const b = runningBrowser(2, 20 * 60_000)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await host.ensureCloudBrowser(ref)
    expect(b.box.state).toBe('paused')
    expect(a.box.state).toBe('running')
  })

  it('a browser already running needs no slot: it never makes anyone give way, and never fails on the cap', async () => {
    for (let i = 1; i <= 4; i++) runningBrowser(i, 30 * 60_000)
    const first = await (async () => {
      vi.stubEnv('CLOUD_BROWSER_MAX_RUNNING', '5')
      return host.ensureCloudBrowser(ref)
    })()
    vi.stubEnv('CLOUD_BROWSER_MAX_RUNNING', '1')
    store.listSlotHolders.mockClear()
    const again = await host.ensureCloudBrowser(ref)
    expect(again).toMatchObject({ created: false, sessionId: first.sessionId })
    expect(store.listSlotHolders).not.toHaveBeenCalled()
    expect(rt.events.filter(e => e.startsWith('pause'))).toEqual([])
  })

  it('never evicts a browser used within the floor, one with a command in flight, or one starting', async () => {
    const watched = runningBrowser(1, 90_000) // a live view pings each minute: inside the 2-minute floor
    const tasking = runningBrowser(2, 50 * 60_000)
    const idle = runningBrowser(3, 10 * 60_000)
    const starting = runningBrowser(4, 60 * 60_000)
    starting.row().status = 'starting'
    store.browsersWithLiveCommands.mockImplementation(async () => new Set(['p2:w2']))
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await host.ensureCloudBrowser(ref)
    expect(idle.box.state).toBe('paused')
    for (const kept of [watched, tasking, starting]) expect(kept.box.state).toBe('running')
    // The live-command check was asked about the candidates only, oldest first.
    expect(store.browsersWithLiveCommands.mock.calls[0][0]).toEqual([tasking.ref, idle.ref])
  })

  it('when none may give way: a clear, retryable error with its own code, nothing created or paused, and the row gives its slot back', async () => {
    runningBrowser(1, 30_000)
    runningBrowser(2, 60_000)
    runningBrowser(3, 50 * 60_000)
    runningBrowser(4, 40 * 60_000)
    store.browsersWithLiveCommands.mockImplementation(async () => new Set(['p3:w3', 'p4:w4']))
    const failed = await host.ensureCloudBrowser(ref).then(() => null, (e: unknown) => e)
    expect(failed).toBeInstanceOf(CloudBrowserBusyError)
    expect(failed).toMatchObject({ message: 'All browsers are in use right now. Try again in a minute.', code: 'BROWSERS_BUSY' })
    expect(isCloudBrowserBusy(failed)).toBe(true)
    expect(rt.Sandbox.create).not.toHaveBeenCalled()
    expect(rt.events.filter(e => e.startsWith('pause'))).toEqual([])
    expect(table.get('u1:w1')).toMatchObject({ status: 'stopped', stop_reason: 'busy' })
    expect(store.markRunning).not.toHaveBeenCalled()
  })

  it('a stuck stopping row counts (its VM may hold memory); the expiry’s claim does not', async () => {
    for (let i = 1; i <= 3; i++) runningBrowser(i, 60_000)
    const stuck = runningBrowser(4, 30 * 60_000)
    stuck.row().status = 'stopping'
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow(CloudBrowserBusyError)
    stuck.row().stop_reason = 'expiring'
    expect((await host.ensureCloudBrowser(ref)).created).toBe(true)
  })

  it('race: the victim’s own ensure touches it first: it is left alone, and the next one gives way', async () => {
    const first = runningBrowser(1, 50 * 60_000)
    const second = runningBrowser(2, 40 * 60_000)
    runningBrowser(3, 60_000)
    runningBrowser(4, 60_000)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    // Between the newcomer's read and its claim, the first's owner uses it (a touch moves last_active_at).
    const real = store.markStopping.getMockImplementation()!
    store.markStopping.mockImplementationOnce(async (r: unknown, seen: unknown) => {
      first.row().last_active_at = new Date().toISOString()
      return real(r, seen)
    })
    await host.ensureCloudBrowser(ref)
    expect(first.box.state).toBe('running')
    expect(first.row().status).toBe('running')
    expect(second.box.state).toBe('paused')
    expect(second.row()).toMatchObject({ status: 'stopped', stop_reason: 'evicted' })
  })

  it('race: the idle sweep claims the same browser first: the eviction leaves it to the sweep and takes the next', async () => {
    const first = runningBrowser(1, 50 * 60_000)
    const second = runningBrowser(2, 40 * 60_000)
    runningBrowser(3, 60_000)
    runningBrowser(4, 60_000)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const real = store.markStopping.getMockImplementation()!
    store.markStopping.mockImplementationOnce(async (r: unknown, seen: unknown) => {
      first.row().status = 'stopping' // the sweep's claim landed
      return real(r, seen)
    })
    await host.ensureCloudBrowser(ref)
    expect(first.box.state).toBe('running') // the sweep's to stop, not ours
    expect(second.row()).toMatchObject({ status: 'stopped', stop_reason: 'evicted' })
  })

  it('race: the victim’s ensure that came before the eviction’s claim keeps it running; one that comes after finds it stopping and needs a slot of its own', async () => {
    const victim = runningBrowser(1, 50 * 60_000)
    runningBrowser(2, 3 * 60_000)
    runningBrowser(3, 60_000)
    runningBrowser(4, 60_000)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await host.ensureCloudBrowser(ref)
    expect(victim.row().status).toBe('stopped')
    // Now its owner comes back: the row is not running, so it is a newcomer like any other, and p2 gives way.
    await host.ensureCloudBrowser(victim.ref)
    expect(table.get('p2:w2')).toMatchObject({ status: 'stopped', stop_reason: 'evicted' })
    const holding = (await store.listSlotHolders()) as TableRow[]
    expect(holding.length).toBe(4)
    expect(runningBoxes()).toBe(4)
  })

  it('race: two newcomers for the last slot never both take it (each counts the other’s starting row)', async () => {
    for (let i = 1; i <= 3; i++) runningBrowser(i, 60_000) // none may give way
    const other = { userId: 'u2', workspaceId: 'w2' }
    const results = await Promise.allSettled([host.ensureCloudBrowser(ref), host.ensureCloudBrowser(other)])
    const ok = results.filter(r => r.status === 'fulfilled').length
    expect(ok).toBeLessThanOrEqual(1)
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(CloudBrowserBusyError)
    expect(runningBoxes()).toBeLessThanOrEqual(4)
    expect(((await store.listSlotHolders()) as TableRow[]).length).toBeLessThanOrEqual(4)
  })

  it('race: two newcomers one after the other: the second counts the first and makes another give way', async () => {
    for (let i = 1; i <= 4; i++) runningBrowser(i, (10 + i) * 60_000)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await host.ensureCloudBrowser(ref)
    await host.ensureCloudBrowser({ userId: 'u2', workspaceId: 'w2' })
    expect(table.get('p4:w4')?.status).toBe('stopped')
    expect(table.get('p3:w3')?.status).toBe('stopped')
    expect(runningBoxes()).toBe(4)
  })

  it('two ensures of one person at once share one slot step: one answer for both', async () => {
    for (let i = 1; i <= 4; i++) runningBrowser(i, (10 + i) * 60_000)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [a, b] = await Promise.all([host.ensureCloudBrowser(ref), host.ensureCloudBrowser(ref)])
    expect(a.hubOrigin).toBe(b.hubOrigin)
    // One slot, one eviction.
    expect(rt.events.filter(e => e.startsWith('pause'))).toHaveLength(1)
    expect(table.get('u1:w1')?.status).toBe('running')
  })

  it('the runtime’s refusal for memory (coding runs share the pool) is "no slot": the browser idle longest gives way, and the create is tried once more', async () => {
    runningBrowser(1, 10 * 60_000)
    const oldest = runningBrowser(2, 30 * 60_000)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusal = new Error('500: Failed to place sandbox: this node cannot map 4096 MiB of guest memory: its memory pool is too small or in use by running sandboxes')
    rt.Sandbox.create.mockImplementationOnce(async () => { throw refusal })
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(true)
    expect(rt.Sandbox.create).toHaveBeenCalledTimes(2)
    expect(oldest.box.state).toBe('paused')
    expect(oldest.row().stop_reason).toBe('evicted')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no memory'))
  })

  it('… a wake refused for memory is never a dead sandbox: nothing created beside it, nothing removed', async () => {
    const mine = rt.add(META, { state: 'paused' })
    table.set('u1:w1', { user_id: 'u1', workspace_id: 'w1', sandbox_name: NAME, session_id: `${mine.sandboxId}.1`, status: 'stopped', started_at: null,
      last_active_at: iso(60 * 60_000), updated_at: iso(60 * 60_000), stop_reason: 'idle' })
    const oldest = runningBrowser(2, 30 * 60_000)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const real = rt.Sandbox.connect.getMockImplementation()!
    rt.Sandbox.connect.mockImplementationOnce(async () => { throw new Error('500: Failed to place sandbox: this node cannot map 4096 MiB of guest memory') })
    const out = await host.ensureCloudBrowser(ref)
    expect(out).toMatchObject({ created: false, hubOrigin: `https://${mine.sandboxId}.hub.test` })
    expect(rt.Sandbox.create).not.toHaveBeenCalled()
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
    expect(oldest.box.state).toBe('paused')
    expect(real).toBeDefined()
  })

  it('… and when it refuses again, or nobody may give way, the same "all in use" error (the row gives its slot back)', async () => {
    runningBrowser(1, 30 * 60_000)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const noRoom = async () => { throw new Error('500: Failed to place sandbox: this node cannot map 4096 MiB of guest memory') }
    rt.Sandbox.create.mockImplementationOnce(noRoom).mockImplementationOnce(noRoom)
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow(CloudBrowserBusyError)
    expect(rt.Sandbox.create).toHaveBeenCalledTimes(2)
    expect(table.get('u1:w1')).toMatchObject({ status: 'stopped', stop_reason: 'busy' })
    // Nobody left to give way: refused at once, with one create only.
    rt.Sandbox.create.mockClear()
    rt.Sandbox.create.mockImplementationOnce(noRoom)
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow('All browsers are in use right now. Try again in a minute.')
    expect(rt.Sandbox.create).toHaveBeenCalledTimes(1)
    expect(rt.Sandbox.kill).not.toHaveBeenCalled()
  })

  it('the sweep reports the slots (holding, cap, evictions of the last hour), and stays as it was otherwise', async () => {
    runningBrowser(1, 60_000)
    runningBrowser(2, 60_000)
    store.countRecentEvictions.mockResolvedValueOnce(3)
    expect(await host.sweepIdleCloudBrowsers()).toEqual({ stopped: 0, skipped: 0, failed: 0, reasons: {}, slots: { cap: 4, running: 2, evictedLastHour: 3 } })
    expect(store.countRecentEvictions.mock.calls[0][0]).toBe(60 * 60_000)
    store.listSlotHolders.mockRejectedValueOnce(new Error('db down'))
    expect((await host.sweepIdleCloudBrowsers()).slots).toBeNull()
  })
})

describe('the shared slots on the hosted backend', () => {
  it('do not apply: no count, no eviction, no release', async () => {
    vi.stubEnv('CLOUD_BROWSER_BACKEND', '')
    vi.stubEnv('CLOUD_BROWSER_MAX_RUNNING', '1')
    await host.sweepIdleCloudBrowsers().then(out => expect(out).not.toHaveProperty('slots'))
    expect(store.listSlotHolders).not.toHaveBeenCalled()
    expect(store.countRecentEvictions).not.toHaveBeenCalled()
  })
})

describe('the hub’s certificate, during the ensure', () => {
  beforeEach(() => useTable())
  const ask = (host_: string) => hubTlsAllowed(host_, { liveSession: id => store.hubSessionLive(id) })

  it('on a create: the row names the new sandbox while it is starting, BEFORE the one background request to its hub', async () => {
    clearHubTlsCache()
    const seenAtRequest: { session: string | null; status: string | undefined; yes: boolean; other: boolean }[] = []
    vi.mocked(fetch).mockImplementation((async (url: string, init: RequestInit & { headers?: Record<string, string> }) => {
      if (String(url).endsWith('.hub.test/health')) {
        const id = new URL(String(url)).hostname.split('.')[0]
        const row = table.get('u1:w1')
        // What our edge would be told at this very handshake, and for any other name.
        rt.events.push(`prewarm ${id}`)
        seenAtRequest.push({ session: row?.session_id ?? null, status: row?.status, yes: await ask(`${id}.hub.test`), other: await ask('zzz999.hub.test') })
        prewarms.push({ url: String(url), init })
        return new Response(null, { status: 502 })
      }
      return new Response(null, { status: 204 })
    }) as never)
    const out = await host.ensureCloudBrowser(ref)
    const box = only()
    expect(prewarms.map(p => p.url)).toEqual([`https://${box.sandboxId}.hub.test/health`])
    expect(seenAtRequest).toEqual([{ session: `${box.sandboxId}.0`, status: 'starting', yes: true, other: false }])
    expect(prewarms[0].init).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store' })
    expect(prewarms[0].init.signal).toBeInstanceOf(AbortSignal)
    // The request went out before the root step ran (as early as the id is final), and the run's real session follows.
    expect(rt.events.indexOf(`prewarm ${box.sandboxId}`)).toBeLessThan(rt.events.indexOf(`run ${box.sandboxId} ${CLOSE_USR_LOCAL}`))
    expect(rt.events.indexOf(`prewarm ${box.sandboxId}`)).toBeGreaterThan(rt.events.indexOf(`create ${box.sandboxId}`))
    expect(table.get('u1:w1')).toMatchObject({ status: 'running', session_id: out.sessionId })
    expect(await ask(`${box.sandboxId}.hub.test`)).toBe(true)
  })

  it('on a wake: the row names the woken sandbox, then its hub is asked for once per process', async () => {
    const mine = rt.add(META, { state: 'paused' })
    table.set('u1:w1', { user_id: 'u1', workspace_id: 'w1', sandbox_name: NAME, session_id: null, status: 'stopped', started_at: null,
      last_active_at: iso(60 * 60_000), updated_at: iso(60 * 60_000), stop_reason: 'idle' })
    const order: string[] = []
    store.recordStartingSandbox.mockImplementationOnce(async (n: string, id: string) => {
      order.push(`record ${id}`)
      const row = [...table.values()].find(r => r.sandbox_name === n)!
      row.session_id = `${id}.0`
    })
    vi.mocked(fetch).mockImplementation((async (url: string) => { order.push(`fetch ${url}`); return new Response(null, { status: 502 }) }) as never)
    await host.ensureCloudBrowser(ref)
    expect(order).toEqual([`record ${mine.sandboxId}`, `fetch https://${mine.sandboxId}.hub.test/health`])
    // Stopped and woken again (same sandbox, same process): no second request.
    await host.stopCloudBrowser(ref, 'idle')
    await host.ensureCloudBrowser(ref)
    expect(order.filter(o => o.startsWith('fetch'))).toHaveLength(1)
  })

  it('never on a running browser taken up again, and never repeated for one sandbox', async () => {
    await host.ensureCloudBrowser(ref)
    await host.ensureCloudBrowser(ref)
    await host.ensureCloudBrowser(ref)
    expect(prewarms).toHaveLength(1)
    expect(store.recordStartingSandbox).toHaveBeenCalledTimes(1)
  })

  it('a failing or hanging request changes nothing, and is never waited for or logged', async () => {
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')
    let release: () => void = () => {}
    vi.mocked(fetch).mockImplementation((async (url: string) => {
      if (String(url).endsWith('.hub.test/health')) {
        await new Promise<void>(resolve => { release = resolve })
        throw new Error(`getaddrinfo ENOTFOUND ${url}`)
      }
      return new Response(null, { status: 204 })
    }) as never)
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(true)
    release()
    await new Promise(resolve => setTimeout(resolve, 5))
    vi.mocked(fetch).mockImplementation((async () => { throw new TypeError('fetch failed') }) as never)
    forgetPrewarmedHubs()
    rt.reset()
    table.clear()
    expect((await host.ensureCloudBrowser(ref)).created).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('a row that cannot be written stops the prewarm (the edge must never be asked before the row says yes), not the ensure', async () => {
    store.recordStartingSandbox.mockRejectedValueOnce(new Error('db down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await host.ensureCloudBrowser(ref)).created).toBe(true)
    expect(prewarms).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no prewarm'), 'db down')
  })

  it('a create that gives way to another sandbox names that one (woken), never its own', async () => {
    let theirs = ''
    rt.hooks.duringCreate = () => {
      rt.hooks.duringCreate = null
      theirs = rt.add(META, { state: 'paused', startedAt: new Date(0) }).sandboxId
    }
    await host.ensureCloudBrowser(ref)
    expect(store.recordStartingSandbox.mock.calls.map(c => c[1])).toEqual([theirs])
    expect(prewarms.map(p => p.url)).toEqual([`https://${theirs}.hub.test/health`])
  })

  it('a create whose root step fails leaves a row that misleads nobody: chooseSandbox never meets the removed id', async () => {
    rt.hooks.close = 'open'
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow(/still writable/)
    expect(table.get('u1:w1')?.session_id).toBe('sbx1.0')
    expect(rt.boxes.has('sbx1')).toBe(false)
    rt.hooks.close = 'ok'
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(true)
    expect(table.get('u1:w1')?.session_id).toBe(out.sessionId)
  })
})
