/**
 * The cloud browser host (src/lib/cloud-browser/host.ts; docs/plans/cloud-browser.md
 * C0) against a fake sandbox SDK and a mocked row store:
 *  - ensure: created from the base snapshot via the SDK's getOrCreate, a lost
 *    create race uses the winner, readiness is polled (start.sh runs detached),
 *    a failure after the VM is up leaves the row for the sweep to reclaim;
 *  - stop: claimed with a compare-and-set, Chrome closed through the session
 *    (never waking a stopped VM), a throwing stop leaves the row "stopping";
 *  - delete and reconcile: every snapshot by name, retry-safe, row last.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sdk = vi.hoisted(() => {
  class FakeSession {
    commands: string[][] = []
    policies: unknown[] = []
    constructor(public sessionId: string, public startedAt: Date) {}
    async update(params: { networkPolicy?: unknown }) { this.policies.push(params.networkPolicy) }
    async runCommand(params: { cmd: string; args: string[] }) {
      this.commands.push([params.cmd, ...params.args])
      return { exitCode: 0, stdout: async () => '' }
    }
  }
  class FakeSandbox {
    status = 'running'
    commands: string[][] = []
    stopped = false
    deleted = false
    stopThrows = false
    /** What start.sh leaves behind: Chrome answering, or a failure marker. */
    startFailure: string | null = null
    /** What the relay start leaves behind: running (this build), or a failure marker. */
    relayFailure: string | null = null
    probes = 0
    relayProbes = 0
    /** The build the last relay start was given: the probe reports it once up. */
    relayBuild = ''
    routes: { port: number; subdomain: string }[] = [{ port: 4000, subdomain: 'sb-4000' }]
    updates: unknown[] = []
    async update(params: { ports?: number[] }) {
      this.updates.push(params)
      if (params.ports) this.routes = params.ports.map(port => ({ port, subdomain: `sb-${port}` }))
    }
    domain(port: number) {
      if (!this.routes.some(route => route.port === port)) throw new Error('no route')
      return `https://sb-${port}.vercel.run`
    }
    session = new FakeSession('sbx_session_1', new Date('2026-10-22T10:00:00Z'))
    constructor(public name: string) {}
    async runCommand(params: { cmd: string; args: string[]; detached?: boolean }) {
      const isProbe = params.cmd === 'bash' && params.args[0] === '-c' && !params.detached
      const relayProbe = isProbe && params.args[1].includes('cloud-browser-relay/build')
      if (relayProbe) this.relayProbes++
      else if (isProbe) this.probes++
      else if (params.args[0] === '-c') { this.relayBuild = params.args[4]; this.commands.push(['relay-start', ...params.args.slice(3), '(detached)']) }
      else this.commands.push([params.cmd, ...params.args, ...(params.detached ? ['(detached)'] : [])])
      const ready = this.startFailure === null && this.probes >= 2 // the first probe finds it still starting
      const relayUp = this.relayFailure === null && this.relayProbes >= 2
      // As relayProbeScript prints it (relay-start.test.ts runs the real one).
      const stdout = relayProbe ? (relayUp ? `build=${this.relayBuild}\nup=1\nfailed=\nhub=200\n` : `build=\nfailed=${this.relayFailure ?? ''}\n`)
        : isProbe ? (ready ? '200\n' : `000\n${this.startFailure ?? ''}`) : ''
      return { exitCode: 0, stdout: async () => stdout }
    }
    currentSession() { return this.session }
    async stop() {
      if (this.stopThrows) throw new Error('stop timed out')
      this.stopped = true
      this.status = 'stopped'
    }
    async delete() {
      this.deleted = true
      sdk.events.push(`delete sandbox ${this.name}`)
      sdk.sandboxes.delete(this.name)
    }
  }
  const apiError = (status: number) => Object.assign(new Error(`status ${status}`), { response: { status } })
  return {
    FakeSandbox, apiError,
    sandboxes: new Map<string, InstanceType<typeof FakeSandbox>>(),
    /** Snapshot ids per sandbox name (status created), until deleted. */
    snapshots: new Map<string, string[]>(),
    getOrCreate: vi.fn(),
    get: vi.fn(),
    snapshotDelete: vi.fn(async (_id: string) => {}),
    events: [] as string[],
  }
})
vi.mock('@vercel/sandbox', () => ({
  Sandbox: {
    getOrCreate: sdk.getOrCreate,
    get: sdk.get,
    list: vi.fn(async ({ namePrefix, sortBy }: { namePrefix: string; sortBy?: string }) => {
      // As the API: a name prefix is only accepted when sorting by name.
      if (sortBy !== 'name') throw sdk.apiError(400)
      return { toArray: async () => [...sdk.sandboxes.keys()].filter(n => n.startsWith(namePrefix)).map(name => ({ name })) }
    }),
  },
  Snapshot: {
    // As the API (measured): once a sandbox is deleted, listing by its name finds nothing.
    list: vi.fn(async ({ name }: { name: string }) => ({
      toArray: async () => (sdk.sandboxes.has(name) ? sdk.snapshots.get(name) ?? [] : []).map(id => ({ id, status: 'created' })),
    })),
    get: vi.fn(async ({ snapshotId }: { snapshotId: string }) => ({
      delete: async () => {
        await sdk.snapshotDelete(snapshotId)
        sdk.events.push(`delete snapshot ${snapshotId}`)
        for (const [name, ids] of sdk.snapshots) sdk.snapshots.set(name, ids.filter(id => id !== snapshotId))
      },
    })),
  },
}))
const store = vi.hoisted(() => ({
  markStarting: vi.fn(async (_ref: { userId: string }, _name: string) => {}),
  markRunning: vi.fn(async (_ref: { userId: string }, _sessionId: string, _startedAt: Date) => {}),
  markStopping: vi.fn(async (_ref: { userId: string }, _seen: unknown) => true),
  markStopped: vi.fn(async (_ref: { userId: string }, _reason: string) => {}),
  touch: vi.fn(async (_ref: { userId: string }) => {}),
  deleteRow: vi.fn(async (_ref: { userId: string }) => {}),
  sandboxNamesWithRows: vi.fn(async (_names: string[]) => new Set<string>()),
  listStopCandidates: vi.fn(async () => [] as unknown[]),
  readStatus: vi.fn(async (_ref: { userId: string }) => null as string | null),
  readExitMode: vi.fn(async (_ref: { userId: string }) => null as string | null),
  recordExit: vi.fn(async () => {}),
}))
vi.mock('@/lib/cloud-browser/store', () => store)
const rings = vi.hoisted(() => [] as string[])
vi.mock('@/lib/browser-agent/queue', () => ({ ringComputer: async (_ref: unknown, event: string) => { rings.push(event) } }))

const host = await import('@/lib/cloud-browser/host')
const { cloudBrowserSandboxName } = await import('@/lib/cloud-browser/ids')

const ref = { userId: 'u1', workspaceId: 'w1' }
const NAME = cloudBrowserSandboxName('u1', 'w1', 'local')
const START = [['rm', '-f', '/tmp/cloud-browser-start.failed'], ['bash', '/opt/cloud-browser/start.sh', '(detached)'],
  ['relay-start', 'https://relay.test', 'dev', '/tmp/cloud-browser-relay', '4000', NAME, '', 'cloud', '(detached)']]

beforeEach(() => {
  vi.clearAllMocks()
  sdk.sandboxes.clear()
  sdk.snapshots.clear()
  sdk.events = []
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  process.env.CLOUD_BROWSER_BASE_SNAPSHOT_ID = 'snap_base'
  vi.stubEnv('CLOUD_BROWSER_RELAY_ORIGIN', 'https://relay.test')
  vi.stubEnv('BROWSER_INTERNAL_SECRET', 'browser-secret')
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '')
  vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '')
  vi.stubEnv('CLOUD_BROWSER_SIGNING_KEY', '')
  store.markStopping.mockImplementation(async () => true)
  store.markStopped.mockImplementation(async () => {})
  sdk.get.mockImplementation(async ({ name }: { name: string }) => {
    const box = sdk.sandboxes.get(name)
    if (!box) throw sdk.apiError(404)
    return box
  })
  sdk.getOrCreate.mockImplementation(async (params: { name: string; onCreate?: () => Promise<void> }) => {
    const existing = sdk.sandboxes.get(params.name)
    if (existing) return existing
    const box = new sdk.FakeSandbox(params.name)
    sdk.sandboxes.set(params.name, box)
    await params.onCreate?.()
    return box
  })
})

describe('ensureCloudBrowser', () => {
  it('creates the sandbox from the base snapshot on first use, starts Chrome detached, and records the session', async () => {
    const out = await host.ensureCloudBrowser(ref)
    expect(out).toMatchObject({ sandboxName: NAME, sessionId: 'sbx_session_1', created: true })
    expect(sdk.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: NAME, source: { type: 'snapshot', snapshotId: 'snap_base' }, persistent: true, resume: true,
      keepLastSnapshots: expect.objectContaining({ count: 1, deleteEvicted: true }), resources: { vcpus: 2 },
    }))
    const box = sdk.sandboxes.get(NAME)!
    expect(box.commands).toEqual(START)
    expect(box.probes).toBe(2)
    expect(store.markStarting).toHaveBeenCalledWith(ref, NAME)
    // The session cap counts from the platform's session start, not this call.
    expect(store.markRunning).toHaveBeenCalledWith(ref, 'sbx_session_1', new Date('2026-10-22T10:00:00Z'))
  })

  it('gives the session its relay token at the firewall, only for the relay’s own requests, and never private ranges', async () => {
    await host.ensureCloudBrowser(ref)
    const [policy] = sdk.sandboxes.get(NAME)!.session.policies as { allow: Record<string, { match: unknown; transform: { headers: Record<string, string> }[] }[]>; subnets: { deny: string[] } }[]
    const [rule, older] = policy.allow['relay.test']
    expect(rule.match).toEqual({ headers: [{ key: { exact: 'x-ni-relay' }, value: { exact: '1' } }] })
    const token = rule.transform[0].headers['x-ni-relay-token']
    // A relay started before the rename marks its requests with the older header: it gets the same token, under the older name.
    expect(policy.allow['relay.test']).toHaveLength(2)
    expect(older.match).toEqual({ headers: [{ key: { exact: 'x-dial8-relay' }, value: { exact: '1' } }] })
    expect(older.transform).toEqual([{ headers: { 'x-dial8-relay-token': token } }])
    expect(rule.transform).toEqual([{ headers: { 'x-ni-relay-token': token } }])
    const { verifyBrowserRelayToken } = await import('@/lib/cloud-browser/relay-token')
    expect(verifyBrowserRelayToken(token)).toMatchObject({ userId: 'u1', workspaceId: 'w1', sandbox: NAME })
    expect(policy.allow['*']).toEqual([])
    // The API takes IPv4 ranges only (checked live: an IPv6 one is a 400).
    expect(policy.subnets.deny).toEqual(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'])
  })

  it('in mac mode lets nothing out but the relay’s own requests, and a start keeps the mode the relay last chose (C4)', async () => {
    store.readExitMode.mockResolvedValueOnce('mac')
    await host.ensureCloudBrowser(ref)
    const [policy] = sdk.sandboxes.get(NAME)!.session.policies as { allow: Record<string, unknown[]> }[]
    expect(Object.keys(policy.allow)).toEqual(['relay.test'])
    await host.setExitMode(ref, 'cloud', { up: false })
    const latest = sdk.sandboxes.get(NAME)!.session.policies.at(-1) as { allow: Record<string, unknown[]> }
    expect(latest.allow['*']).toEqual([])
    expect(store.recordExit).toHaveBeenCalledWith(ref, 'cloud', { up: false })
  })

  it('rings the person’s Mac when the browser comes up, not on every ensure, and when it stops (C4)', async () => {
    rings.length = 0
    await host.ensureCloudBrowser(ref)
    store.readStatus.mockResolvedValueOnce('running')
    await host.ensureCloudBrowser(ref)
    expect(rings).toEqual(['browser-up'])
    await host.stopCloudBrowser(ref, 'idle')
    expect(rings).toEqual(['browser-up', 'browser-down'])
  })

  it('passes a protected preview’s bypass along with the token', async () => {
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'bypass-1')
    await host.ensureCloudBrowser(ref)
    const [policy] = sdk.sandboxes.get(NAME)!.session.policies as { allow: Record<string, { transform: { headers: Record<string, string> }[] }[]> }[]
    expect(policy.allow['relay.test'][0].transform[0].headers['x-vercel-protection-bypass']).toBe('bypass-1')
  })

  it('fails with the relay’s reason, and needs a relay origin', async () => {
    const box = new sdk.FakeSandbox(NAME)
    box.relayFailure = 'fetch relay.mjs failed'
    sdk.sandboxes.set(NAME, box)
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow('cloud browser relay failed: fetch relay.mjs failed')
    vi.stubEnv('CLOUD_BROWSER_RELAY_ORIGIN', '')
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow('no relay origin')
  })

  it('publishes the hub’s port, and gives the relay the public key only when the live view is set up', async () => {
    const created = await host.ensureCloudBrowser(ref)
    expect(created.hubOrigin).toBe('https://sb-4000.vercel.run')
    expect(sdk.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ ports: [4000] }))

    const { generateKeyPairSync } = await import('node:crypto')
    const { privateKey } = generateKeyPairSync('ed25519')
    vi.stubEnv('CLOUD_BROWSER_SIGNING_KEY', privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
    const old = new sdk.FakeSandbox(NAME)
    old.routes = [] // a browser created before the hub
    sdk.sandboxes.set(NAME, old)
    const resumed = await host.ensureCloudBrowser(ref)
    expect(old.updates).toEqual([{ ports: [4000] }])
    expect(resumed.hubOrigin).toBe('https://sb-4000.vercel.run')
    const start = old.commands.find(command => command[0] === 'relay-start')!
    const [, , build, , , , verifyKey] = start
    expect(build).toMatch(/^dev\+[a-f0-9]{12}$/)
    const { sandboxVerifyKey } = await import('@/lib/cloud-browser/viewer-token')
    expect(verifyKey).toBe(sandboxVerifyKey(privateKey))
    // Only the public half goes in.
    expect(start.join(' ')).not.toContain(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
  })

  it('resumes an existing sandbox instead of creating one', async () => {
    sdk.sandboxes.set(NAME, new sdk.FakeSandbox(NAME))
    expect((await host.ensureCloudBrowser(ref)).created).toBe(false)
  })

  it('uses the winner when a concurrent caller created it first (the API answers 400 "already exists")', async () => {
    const winner = new sdk.FakeSandbox(NAME)
    sdk.getOrCreate.mockImplementationOnce(async () => {
      sdk.sandboxes.set(NAME, winner)
      throw sdk.apiError(400)
    })
    const out = await host.ensureCloudBrowser(ref)
    expect(out.created).toBe(false)
    expect(winner.commands).toEqual(START)
  })

  it('rethrows a create failure when no sandbox exists after it', async () => {
    sdk.getOrCreate.mockRejectedValueOnce(sdk.apiError(500))
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow('status 500')
  })

  it('fails without a base snapshot', async () => {
    delete process.env.CLOUD_BROWSER_BASE_SNAPSHOT_ID
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow('CLOUD_BROWSER_BASE_SNAPSHOT_ID is not set')
  })

  it('fails with the reason start.sh wrote, and leaves the row for the sweep (never marked stopped over a live VM)', async () => {
    const box = new sdk.FakeSandbox(NAME)
    box.startFailure = 'Chrome did not open CDP within 15 s'
    sdk.sandboxes.set(NAME, box)
    await expect(host.ensureCloudBrowser(ref)).rejects.toThrow('cloud browser start failed: Chrome did not open CDP within 15 s')
    expect(store.markRunning).not.toHaveBeenCalled()
    expect(store.markStopped).not.toHaveBeenCalled()
  })
})

describe('stopCloudBrowser', () => {
  it('closes Chrome through the session (never waking a stopped VM), then stops it', async () => {
    const box = new sdk.FakeSandbox(NAME)
    sdk.sandboxes.set(NAME, box)
    expect(await host.stopCloudBrowser(ref, 'idle')).toBe('stopped')
    expect(sdk.get).toHaveBeenCalledWith(expect.objectContaining({ name: NAME, resume: false }))
    expect(box.session.commands).toEqual([['bash', '/opt/cloud-browser/stop.sh']])
    expect(box.commands).toEqual([])
    expect(box.stopped).toBe(true)
    expect(store.markStopped).toHaveBeenCalledWith(ref, 'idle')
  })

  it('leaves a browser alone when the compare-and-set finds it changed', async () => {
    sdk.sandboxes.set(NAME, new sdk.FakeSandbox(NAME))
    store.markStopping.mockResolvedValueOnce(false)
    expect(await host.stopCloudBrowser(ref, 'idle', { reason: 'idle' } as never)).toBe('changed')
    expect(sdk.get).not.toHaveBeenCalled()
    expect(sdk.sandboxes.get(NAME)!.stopped).toBe(false)
  })

  it('does nothing to a VM that is already stopped', async () => {
    const box = new sdk.FakeSandbox(NAME)
    box.status = 'stopped'
    sdk.sandboxes.set(NAME, box)
    expect(await host.stopCloudBrowser(ref, 'idle')).toBe('already_stopped')
    expect(box.session.commands).toEqual([])
    expect(store.markStopped).toHaveBeenCalledWith(ref, 'idle')
  })

  it('leaves the row "stopping" when the stop throws, so the next sweep retries it', async () => {
    const box = new sdk.FakeSandbox(NAME)
    box.stopThrows = true
    sdk.sandboxes.set(NAME, box)
    await expect(host.stopCloudBrowser(ref, 'idle')).rejects.toThrow('stop timed out')
    expect(store.markStopped).not.toHaveBeenCalled()
  })

  it('records a missing sandbox as stopped', async () => {
    expect(await host.stopCloudBrowser(ref, 'requested')).toBe('missing')
    expect(store.markStopped).toHaveBeenCalledWith(ref, 'requested')
  })
})

describe('deleteCloudBrowser', () => {
  it('stops a running sandbox, deletes its snapshots while it still names them, then the sandbox, then the row', async () => {
    const box = new sdk.FakeSandbox(NAME)
    sdk.sandboxes.set(NAME, box)
    sdk.snapshots.set(NAME, ['snap_a', 'snap_b'])
    sdk.snapshots.set('browser-local-other', ['snap_other'])
    expect(await host.deleteCloudBrowser(ref)).toEqual({ snapshotsDeleted: 2 })
    expect(box.stopped).toBe(true)
    expect(sdk.events).toEqual(['delete snapshot snap_a', 'delete snapshot snap_b', `delete sandbox ${NAME}`])
    expect(store.deleteRow).toHaveBeenCalledWith(ref)
  })

  it('keeps the sandbox and the row when a snapshot cannot be deleted, so a retry finds what is left', async () => {
    sdk.sandboxes.set(NAME, new sdk.FakeSandbox(NAME))
    sdk.snapshots.set(NAME, ['snap_a'])
    sdk.snapshotDelete.mockRejectedValueOnce(sdk.apiError(500))
    await expect(host.deleteCloudBrowser(ref)).rejects.toThrow('status 500')
    expect(sdk.sandboxes.has(NAME)).toBe(true)
    expect(store.deleteRow).not.toHaveBeenCalled()
    expect(await host.deleteCloudBrowser(ref)).toEqual({ snapshotsDeleted: 1 })
    expect(sdk.sandboxes.has(NAME)).toBe(false)
    expect(store.deleteRow).toHaveBeenCalledWith(ref)
  })

  it('deletes just the row when the sandbox is already gone', async () => {
    expect(await host.deleteCloudBrowser(ref)).toEqual({ snapshotsDeleted: 0 })
    expect(store.deleteRow).toHaveBeenCalledWith(ref)
  })
})

describe('sweepIdleCloudBrowsers', () => {
  it('stops each candidate it can claim, skips changed ones, and one failure does not stop the rest', async () => {
    store.listStopCandidates.mockResolvedValueOnce([
      { user_id: 'u1', workspace_id: 'w1', reason: 'idle' },
      { user_id: 'u2', workspace_id: 'w2', reason: 'session_limit' },
      { user_id: 'u3', workspace_id: 'w3', reason: 'idle' },
    ])
    sdk.sandboxes.set(NAME, new sdk.FakeSandbox(NAME))
    store.markStopping.mockImplementation(async (r: { userId: string }) => r.userId !== 'u3')
    store.markStopped.mockImplementation(async (r: { userId: string }) => { if (r.userId === 'u2') throw new Error('db down') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await host.sweepIdleCloudBrowsers()).toEqual({ stopped: 1, skipped: 1, failed: 1, reasons: { idle: 1 } })
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('reconcileCloudBrowsers', () => {
  it('deletes only this database\'s browser sandboxes that no row owns, with their snapshots', async () => {
    const orphan = cloudBrowserSandboxName('u9', 'w9', 'local')
    sdk.sandboxes.set(NAME, new sdk.FakeSandbox(NAME))
    sdk.sandboxes.set(orphan, new sdk.FakeSandbox(orphan))
    sdk.sandboxes.set('browser-otherdb-x', new sdk.FakeSandbox('browser-otherdb-x'))
    sdk.snapshots.set(orphan, ['snap_orphan'])
    store.sandboxNamesWithRows.mockResolvedValueOnce(new Set([NAME]))
    expect(await host.reconcileCloudBrowsers()).toEqual({ orphans: 1, snapshotsDeleted: 1 })
    expect(store.sandboxNamesWithRows).toHaveBeenCalledWith([NAME, orphan])
    expect(sdk.sandboxes.has(orphan)).toBe(false)
    expect(sdk.sandboxes.has(NAME)).toBe(true)
    expect(sdk.sandboxes.has('browser-otherdb-x')).toBe(true)
  })
})
