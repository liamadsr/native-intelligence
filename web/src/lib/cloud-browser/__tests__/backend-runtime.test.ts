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
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rt = vi.hoisted(() => {
  interface Box {
    sandboxId: string
    metadata: Record<string, string>
    state: 'running' | 'paused'
    startedAt: Date
    /** Listed as running, but its agent is gone (the runtime restarted under it). */
    dead?: 'not-running' | 'unreachable'
    files: Map<string, string>
    lines: { line: string; detached: boolean; envs: unknown }[]
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
  const hooks = { duringCreate: null as null | (() => void), createError: null as null | Error }
  const named = (name: string, message: string) => Object.assign(new Error(message), { name })

  /** The words of a command line the backend built with shellQuote. */
  function words(line: string): string[] {
    const out: string[] = []
    const re = /'((?:[^']|'\\'')*)'/g
    for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1].split("'\\''").join("'"))
    return out
  }

  function answer(box: Box, line: string): string {
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
        run: async (line: string, options: { timeoutMs?: number; envs?: unknown }) => {
          if (!boxes.has(box.sandboxId) || box.state !== 'running' || box.dead === 'not-running') throw named('SandboxNotRunningError', 'The sandbox is not running')
          if (box.dead === 'unreachable') throw named('SandboxUnreachableError', 'The sandbox could not be reached')
          box.lines.push({ line, detached: options.timeoutMs === 0, envs: options.envs })
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
    kill: vi.fn(async (sandboxId: string) => {
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
      return { sandboxId, metadata: { ...b.metadata }, state: b.state, startedAt: b.startedAt }
    }),
  }
  return { boxes, events, creates, hooks, Sandbox, add, words, named, reset() { boxes.clear(); events.length = 0; creates.length = 0; seq = 0; hooks.duringCreate = null; hooks.createError = null } }
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
  deleteRowIfUnusedSince: vi.fn(async (_ref: unknown, _at: string) => true),
}))
vi.mock('@/lib/cloud-browser/store', () => store)
vi.mock('@/lib/browser-agent/queue', () => ({ ringComputer: async () => {} }))

const host = await import('@/lib/cloud-browser/host')
const { cloudBrowserSandboxName } = await import('@/lib/cloud-browser/ids')
const { verifyBrowserRelayToken } = await import('@/lib/cloud-browser/relay-token')
const { createRuntimeBackend, firstOf, runtimeNetworkFor, sandboxIdOfSession } = await import('@/lib/cloud-browser/backend-runtime')
type RuntimeBrowserClient = import('@/lib/cloud-browser/runtime-client').RuntimeBrowserClient

const KEY = 'e2b_secret_key_123'
const ref = { userId: 'u1', workspaceId: 'w1' }
const NAME = cloudBrowserSandboxName('u1', 'w1', 'local')
const META = { niKind: 'cloud-browser', niName: NAME, niNs: 'local' }
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16']
const SIX_HOURS = 6 * 60 * 60 * 1000

beforeEach(() => {
  vi.clearAllMocks()
  rt.reset()
  hostedCalls.length = 0
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
    expect(box.network).toEqual([{ allowOut: ['relay.test'], denyOut: ['0.0.0.0/0'] }])
    await host.setExitMode(ref, 'cloud', { up: false }, 'https://browser-relay.dial8.ai')
    expect(box.network.at(-1)).toEqual({ allowInternetAccess: true, denyOut: PRIVATE })
    await host.setExitMode(ref, 'mac', { up: true }, 'https://browser-relay.dial8.ai')
    expect(box.network.at(-1)).toEqual({ allowOut: ['browser-relay.dial8.ai'], denyOut: ['0.0.0.0/0'] })
    expect(store.recordExit).toHaveBeenCalledWith(ref, 'mac', { up: true })
    expect(JSON.stringify(box.network)).not.toMatch(/rules|transform|headers/)
  })

  it('writes the relay token by the file API into a 0700 directory, 0600, renamed into place: never in a command line or env', async () => {
    await host.ensureCloudBrowser(ref)
    const box = only()
    const token = box.files.get('/tmp/cloud-browser-relay/secret/token')!
    expect(verifyBrowserRelayToken(token)).toMatchObject({ userId: 'u1', workspaceId: 'w1', sandbox: NAME })
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
    expect(start.slice(3)).toEqual(['relay-start', 'https://relay.test', 'dev', '/tmp/cloud-browser-relay', '4000', NAME, '', 'cloud', '/tmp/cloud-browser-relay/secret/token'])
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

  it('replaces a sandbox listed as running whose agent is gone (the runtime restarted under it)', async () => {
    const dead = rt.add(META, { dead: 'not-running' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(true)
    expect(rt.boxes.has(dead.sandboxId)).toBe(false)
    expect(out.hubOrigin).toBe(`https://${only().sandboxId}.hub.test`)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('never kills a running sandbox it merely could not reach: the ensure fails instead', async () => {
    const box = rt.add(META, { dead: 'unreachable' })
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow(/could not reach sandbox/)
    expect(rt.boxes.has(box.sandboxId)).toBe(true)
    expect(rt.Sandbox.create).not.toHaveBeenCalled()
  })

  it('two creates for one name end with one: the later one is killed and the earlier one used', async () => {
    let theirs = ''
    rt.hooks.duringCreate = () => {
      rt.hooks.duringCreate = null
      // Another ensure's create, which the runtime started first.
      const other = rt.add(META, { startedAt: new Date(0), runStart: '1700000000000' })
      theirs = other.sandboxId
    }
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(false)
    expect(only().sandboxId).toBe(theirs)
    expect(out.sessionId).toBe(`${theirs}.1700000000000`)
  })

  it('… and when ours came first, the other is killed and ours kept', async () => {
    rt.hooks.duringCreate = () => {
      rt.hooks.duringCreate = null
      rt.add(META, { startedAt: new Date(Date.now() + 60_000) })
    }
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(true)
    expect(out.hubOrigin).toBe(`https://${only().sandboxId}.hub.test`)
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
    expect(store.markStopped).toHaveBeenCalledWith(ref, 'idle')
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

  it('names a browser sandbox of this database, running or paused, and nothing else', async () => {
    const backend = createRuntimeBackend({ loadClient: async () => ({ Sandbox: rt.Sandbox }) as unknown as RuntimeBrowserClient })
    const running = rt.add(META)
    const paused = rt.add(META, { state: 'paused' })
    const other = rt.add({ ...META, niNs: 'otherdb' })
    const coding = rt.add({ eveSessionId: 's1' })
    expect(await backend.isBrowserSandbox(running.sandboxId)).toBe(true)
    expect(await backend.isBrowserSandbox(paused.sandboxId)).toBe(true)
    expect(await backend.isBrowserSandbox(other.sandboxId)).toBe(false)
    expect(await backend.isBrowserSandbox(coding.sandboxId)).toBe(false)
    expect(await backend.isBrowserSandbox('missing1')).toBe(false)
    expect(await backend.isBrowserSandbox('Not-An-Id')).toBe(false)
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
    expect(await host.reconcileCloudBrowsers(now)).toEqual({ orphans: 1, snapshotsDeleted: 0, expired: 1 })
    expect(store.sandboxNamesWithRows).toHaveBeenCalledWith([NAME, oldName, orphanName].sort())
    expect(rt.boxes.has(orphan.sandboxId)).toBe(false)
    expect(rt.boxes.has(owned.sandboxId)).toBe(true)
    expect(rt.boxes.has(otherDb.sandboxId)).toBe(true)
    // Unused for 60 days: its VM, then its row (only if still untouched).
    const [cutoff, limit] = store.listUnusedStopped.mock.calls[0]
    expect(cutoff.toISOString()).toBe(new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString())
    expect(limit).toBe(50)
    expect(rt.boxes.has(old.sandboxId)).toBe(false)
    expect(store.deleteRowIfUnusedSince).toHaveBeenCalledWith({ userId: 'u7', workspaceId: 'w7' }, '2026-12-01T00:00:00.000Z')
  })

  it('keeps going past one expiry that fails, and counts only the rows it removed', async () => {
    store.listUnusedStopped.mockResolvedValueOnce([
      { user_id: 'u7', workspace_id: 'w7', sandbox_name: 'browser-local-a', status: 'stopped', last_active_at: 't1' },
      { user_id: 'u8', workspace_id: 'w8', sandbox_name: 'browser-local-b', status: 'stopped', last_active_at: 't2' },
      { user_id: 'u9', workspace_id: 'w9', sandbox_name: 'browser-local-c', status: 'stopped', last_active_at: 't3' },
    ])
    rt.add({ ...META, niName: 'browser-local-a' })
    rt.Sandbox.kill.mockImplementationOnce(async () => { throw new Error('runtime down') })
    store.deleteRowIfUnusedSince.mockResolvedValueOnce(false) // u8: an ensure came in between
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.sandboxNamesWithRows.mockResolvedValueOnce(new Set(['browser-local-a']))
    expect(await host.reconcileCloudBrowsers()).toMatchObject({ expired: 1 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(store.deleteRowIfUnusedSince).toHaveBeenCalledTimes(2)
  })
})

describe('runtimeNetworkFor', () => {
  it('maps the two modes, a relay origin with a port or path to its host name', () => {
    expect(runtimeNetworkFor('mac', 'https://browser-relay.nativeintelligence.dev:443/x')).toEqual({ allowOut: ['browser-relay.nativeintelligence.dev'], denyOut: ['0.0.0.0/0'] })
    expect(runtimeNetworkFor('cloud', 'https://r.test')).toEqual({ allowInternetAccess: true, denyOut: PRIVATE })
  })
})
