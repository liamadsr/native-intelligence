/**
 * The `ni-runtime` sandbox provider (lib/runtime-sandbox.ts) against a fake of
 * the runtime's client. What is pinned:
 *   - the network policy maps to creation options (deny-all: no internet; an
 *     allow list with '*': open; any other list: deny 0.0.0.0/0 and allow
 *     exactly its hosts), any header rule throws before anything is created,
 *     and no later call ever changes a sandbox's network;
 *   - a 60-minute lifetime at creation, pushed out to 60 minutes on every
 *     resume; resume of a gone sandbox throws and creates nothing;
 *   - delete is idempotent, shutdown does nothing, prepare() calls nothing;
 *   - the API key is in no state, artifact, command, env, metadata or error;
 *   - the session: bash -l -c (the client's own runner) in /workspace with
 *     AI_AGENT=eve, a nonzero exit as a result, spawn's streams / wait / kill /
 *     abort, and the file methods' null / mkdir / overwrite / line ranges.
 * The real client and runtime are exercised by scripts/runtime-conformance.mts.
 * Every value here is made up.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createRuntimeSandboxImplementation,
  createRuntimeSession,
  runtimeNetworkOptions,
  RuntimeSandbox,
  SANDBOX_LIFETIME_MS,
  type RuntimeClient,
  type RuntimeCommandStartOptions,
  type RuntimeSandboxInstance,
} from '../runtime-sandbox'
import { buildNetworkPolicy, RESTRICTED_ALLOW_HOSTS } from '../../sandbox'

const KEY = 'e2b_0123456789abcdef0123456789abcdef01234567'
const API_URL = 'http://10.200.77.2:3000'
const TRAFFIC_URL = 'http://10.200.77.2:3002'
const TEMPLATE = 'ni-coding-agent'
const GATE_URL = 'https://app.example.com/api/internal/agent-run/git'
const OPTIONS = { apiUrl: API_URL, trafficUrl: TRAFFIC_URL, template: TEMPLATE }
const CTX = { session: { id: 'wrun_MADEUP01' } } as never
const ARTIFACT = { template: TEMPLATE }

type Script = {
  stdout?: string[]
  stderr?: string[]
  exitCode?: number
  /** Never exits on its own (until killed). */
  hang?: boolean
}

type Call = { kind: string; args: unknown[] }

class FakeSandbox implements RuntimeSandboxInstance {
  files: RuntimeSandboxInstance['files']
  commands: RuntimeSandboxInstance['commands']
  fs = new Map<string, Uint8Array>()
  runs: Array<{ command: string; options: RuntimeCommandStartOptions }> = []
  killedPids: number[] = []
  constructor(
    readonly sandboxId: string,
    private readonly calls: Call[],
    private readonly script: (command: string) => Script = () => ({}),
  ) {
    let nextPid = 100
    this.commands = {
      run: async (command, options) => {
        this.calls.push({ kind: 'commands.run', args: [command, options] })
        this.runs.push({ command, options })
        const pid = nextPid++
        const s = this.script(command)
        let finish!: (code: number) => void
        const done = new Promise<number>((resolve) => (finish = resolve))
        const handle = {
          pid,
          wait: async () => {
            const code = await done
            if (code !== 0) {
              throw Object.assign(new Error(`exit status ${code}`), { name: 'CommandExitError', exitCode: code, stdout: '', stderr: '' })
            }
            return { exitCode: 0 }
          },
          kill: async () => {
            this.killedPids.push(pid)
            finish(137)
            return true
          },
        }
        queueMicrotask(async () => {
          for (const chunk of s.stdout ?? []) options.onStdout(chunk)
          for (const chunk of s.stderr ?? []) options.onStderr(chunk)
          if (!s.hang) finish(s.exitCode ?? 0)
        })
        return handle
      },
    }
    this.files = {
      read: async (path) => {
        this.calls.push({ kind: 'files.read', args: [path] })
        const bytes = this.fs.get(path)
        if (!bytes) throw Object.assign(new Error(`file ${path} not found`), { name: 'FileNotFoundError' })
        return bytes
      },
      write: async (path, data) => {
        this.calls.push({ kind: 'files.write', args: [path] })
        this.fs.set(path, new Uint8Array(data))
        return { path }
      },
    }
  }
  async setTimeout(ms: number) {
    this.calls.push({ kind: 'setTimeout', args: [ms] })
  }
  async pause() {
    this.calls.push({ kind: 'pause', args: [] })
    return true
  }
}

function fakeClient(opts: { script?: (command: string) => Script; existing?: string[]; killMissing?: 'false' | 'throws' } = {}) {
  const calls: Call[] = []
  const live = new Set(opts.existing ?? [])
  let n = 0
  const sandboxes: FakeSandbox[] = []
  const client: RuntimeClient = {
    Sandbox: {
      create: async (template, options) => {
        calls.push({ kind: 'create', args: [template, options] })
        const sbx = new FakeSandbox(`sbx_madeup${++n}`, calls, opts.script)
        live.add(sbx.sandboxId)
        sandboxes.push(sbx)
        return sbx
      },
      connect: async (sandboxId, options) => {
        calls.push({ kind: 'connect', args: [sandboxId, options] })
        if (!live.has(sandboxId)) throw Object.assign(new Error(`Paused sandbox ${sandboxId} not found`), { name: 'SandboxNotFoundError' })
        const sbx = new FakeSandbox(sandboxId, calls, opts.script)
        sandboxes.push(sbx)
        return sbx
      },
      kill: async (sandboxId, options) => {
        calls.push({ kind: 'kill', args: [sandboxId, options] })
        if (live.delete(sandboxId)) return true
        if (opts.killMissing === 'throws') throw Object.assign(new Error('not found'), { name: 'SandboxNotFoundError' })
        return false
      },
    },
  }
  const loadClient = vi.fn(async () => client)
  return { calls, loadClient, sandboxes, live }
}

function implementation(fake: ReturnType<typeof fakeClient>, env: Record<string, string | undefined> = { SANDBOX_RUNTIME_KEY: KEY }) {
  return createRuntimeSandboxImplementation(OPTIONS, { loadClient: fake.loadClient, env })
}

const policyFor = (level: string) => buildNetworkPolicy(level as never, { gateUrl: GATE_URL, broker: null })
const createOptions = (fake: ReturnType<typeof fakeClient>) =>
  fake.calls.filter((c) => c.kind === 'create').map((c) => c.args[1] as Record<string, unknown>)
const leaksKey = (value: unknown) => JSON.stringify(value ?? null).includes(KEY)

describe('runtimeNetworkOptions: the policy, as the runtime takes it at creation', () => {
  it('deny-all: no internet at all', () => {
    expect(runtimeNetworkOptions('deny-all')).toEqual({ allowInternetAccess: false })
  })

  it('trusted (an allow list with "*"): open internet', () => {
    expect(runtimeNetworkOptions(policyFor('trusted'))).toEqual({ allowInternetAccess: true })
    expect(runtimeNetworkOptions('allow-all')).toEqual({ allowInternetAccess: true })
  })

  it('restricted: deny everything, allow exactly its hosts and the gate (wildcards as they are)', () => {
    expect(runtimeNetworkOptions(policyFor('restricted'))).toEqual({
      network: { allowOut: [...RESTRICTED_ALLOW_HOSTS, 'app.example.com'], denyOut: ['0.0.0.0/0'] },
    })
    expect(runtimeNetworkOptions(policyFor('restricted')).network!.allowOut).toContain('*.githubusercontent.com')
  })

  it('isolated, and any level this code does not know: github.com and the gate only', () => {
    for (const level of ['isolated', 'something-new']) {
      expect(runtimeNetworkOptions(policyFor(level))).toEqual({
        network: { allowOut: ['github.com', 'app.example.com'], denyOut: ['0.0.0.0/0'] },
      })
    }
  })

  it('THROWS on any host with a rule (the runtime stores header rules without applying them)', () => {
    const brokered = buildNetworkPolicy('restricted', { gateUrl: GATE_URL, broker: { gateToken: 'gate.madeup' } })
    expect(() => runtimeNetworkOptions(brokered)).toThrow(/carries rules for app\.example\.com/)
    const onStar = { allow: { '*': [{ transform: [{ headers: { a: 'b' } }] }] } } as never
    expect(() => runtimeNetworkOptions(onStar)).toThrow(/carries rules/)
    expect(() => runtimeNetworkOptions({ allow: ['github.com'], subnets: { allow: ['10.0.0.0/8'] } } as never)).toThrow(/subnets/)
  })
})

describe('the ni-runtime provider', () => {
  it('is named ni-runtime', () => {
    expect(RuntimeSandbox.name).toBe('ni-runtime')
  })

  it('prepare() returns the template and calls nothing: no client, no key (it runs inside eve build)', async () => {
    const fake = fakeClient()
    const impl = implementation(fake, {})
    const ctx = { resources: { source: { kind: 'none' } } } as never
    expect(await impl.prepare(ctx)).toEqual({ template: TEMPLATE })
    expect(fake.loadClient).not.toHaveBeenCalled()
    expect(fake.calls).toEqual([])
  })

  it('prepare() refuses workspace seeds or skills rather than drop them', async () => {
    const impl = implementation(fakeClient())
    const ctx = { resources: { source: { kind: 'inline', key: 'k' }, skills: { files: [{ relativePath: 'a', content: 'x' }], key: 'k', mountPath: '/m', targetPath: '/t' } } } as never
    await expect(impl.prepare(ctx)).rejects.toThrow(/does not upload/)
  })

  it('start(): the policy is a CREATION option, with a 60-minute lifetime and the session id, and nothing after widens or narrows it', async () => {
    for (const level of ['deny-all', 'trusted', 'restricted', 'isolated', 'something-new']) {
      const fake = fakeClient()
      const policy = level === 'deny-all' ? ('deny-all' as const) : policyFor(level)
      const { handle, state } = await implementation(fake).start(CTX, { networkPolicy: policy }, ARTIFACT)
      expect(fake.calls[0].kind).toBe('create')
      expect(fake.calls[0].args[0]).toBe(TEMPLATE)
      expect(fake.calls[0].args[1]).toEqual({
        apiKey: KEY,
        apiUrl: API_URL,
        sandboxUrl: TRAFFIC_URL,
        timeoutMs: SANDBOX_LIFETIME_MS,
        metadata: { eveSessionId: 'wrun_MADEUP01' },
        ...runtimeNetworkOptions(policy),
      })
      expect(state).toEqual({ sandboxId: 'sbx_madeup1', version: 1 })
      // Use the sandbox: nothing it does touches the network configuration.
      await handle.sandbox.run({ command: 'true' })
      await handle.sandbox.writeTextFile({ path: 'a.txt', content: 'x' })
      expect(fake.calls.filter((c) => c.kind === 'create')).toHaveLength(1)
      expect(fake.calls.map((c) => c.kind)).toEqual(['create', 'commands.run', 'files.write'])
    }
  })

  it('start() with a header rule throws BEFORE anything is created, and never without a policy', async () => {
    const fake = fakeClient()
    const brokered = buildNetworkPolicy('isolated', { gateUrl: GATE_URL, broker: { gateToken: 'gate.madeup' } })
    await expect(implementation(fake).start(CTX, { networkPolicy: brokered }, ARTIFACT)).rejects.toThrow(/carries rules/)
    await expect(implementation(fake).start(CTX, undefined, ARTIFACT)).rejects.toThrow(/without an explicit network policy/)
    await expect(implementation(fake).start(CTX, { networkPolicy: undefined } as never, ARTIFACT)).rejects.toThrow(/explicit network policy/)
    expect(createOptions(fake)).toEqual([])
  })

  it('start() needs the key, and says which setting is missing (the build needs none)', async () => {
    const fake = fakeClient()
    await expect(implementation(fake, {}).start(CTX, { networkPolicy: 'deny-all' }, ARTIFACT)).rejects.toThrow(/SANDBOX_RUNTIME_KEY is not set/)
    await expect(implementation(fake, { SANDBOX_RUNTIME_KEY: '  ' }).start(CTX, { networkPolicy: 'deny-all' }, ARTIFACT)).rejects.toThrow(/SANDBOX_RUNTIME_KEY/)
    expect(fake.calls).toEqual([])
  })

  it('resume(): reconnects and pushes the lifetime out to 60 minutes, in two calls', async () => {
    const fake = fakeClient({ existing: ['sbx_kept'] })
    const handle = await implementation(fake).resume(CTX, ARTIFACT, { sandboxId: 'sbx_kept', version: 1 })
    expect(fake.calls).toEqual([
      { kind: 'connect', args: ['sbx_kept', { apiKey: KEY, apiUrl: API_URL, sandboxUrl: TRAFFIC_URL, timeoutMs: SANDBOX_LIFETIME_MS }] },
      { kind: 'setTimeout', args: [SANDBOX_LIFETIME_MS] },
    ])
    expect(SANDBOX_LIFETIME_MS).toBe(60 * 60 * 1000)
    expect(typeof handle.sandbox.run).toBe('function')
  })

  it('resume() of a sandbox that is gone throws, says so, and creates nothing', async () => {
    const fake = fakeClient()
    await expect(implementation(fake).resume(CTX, ARTIFACT, { sandboxId: 'sbx_gone', version: 1 })).rejects.toThrow(
      /sandbox sbx_gone no longer exists/,
    )
    expect(fake.calls.map((c) => c.kind)).toEqual(['connect'])
    await expect(implementation(fake).resume(CTX, ARTIFACT, { sandboxId: '', version: 1 } as never)).rejects.toThrow(/invalid session state/)
  })

  it('delete kills the sandbox, and a second delete (not found) is fine, whichever way the client says so', async () => {
    for (const killMissing of ['false', 'throws'] as const) {
      const fake = fakeClient({ killMissing })
      const impl = implementation(fake)
      const { handle } = await impl.start(CTX, { networkPolicy: 'deny-all' }, ARTIFACT)
      await handle.onSandboxDelete()
      await handle.onSandboxDelete()
      await impl.onSessionEnd!(CTX, ARTIFACT, { sandboxId: 'sbx_madeup1', version: 1 }, { reason: 'completed' })
      expect(fake.calls.filter((c) => c.kind === 'kill').map((c) => c.args[0])).toEqual(['sbx_madeup1', 'sbx_madeup1', 'sbx_madeup1'])
      expect(fake.live.size).toBe(0)
    }
  })

  it('runtime shutdown does nothing (the sandbox outlives the agent\'s container); stop pauses', async () => {
    const fake = fakeClient()
    const { handle } = await implementation(fake).start(CTX, { networkPolicy: 'deny-all' }, ARTIFACT)
    const before = fake.calls.length
    await handle.onRuntimeShutdown()
    expect(fake.calls.length).toBe(before)
    await handle.onSandboxStop()
    expect(fake.calls.slice(before).map((c) => c.kind)).toEqual(['pause'])
  })

  it('the key is in no state, artifact, metadata, command, env or error message', async () => {
    const fake = fakeClient({ existing: ['sbx_kept'] })
    const impl = implementation(fake)
    const artifact = await impl.prepare({ resources: { source: { kind: 'none' } } } as never)
    const { handle, state } = await impl.start(CTX, { networkPolicy: policyFor('restricted') }, artifact)
    await handle.sandbox.run({ command: 'echo hi', env: { FOO: 'bar' } })
    expect(leaksKey(artifact)).toBe(false)
    expect(leaksKey(state)).toBe(false)
    expect(leaksKey(createOptions(fake)[0].metadata)).toBe(false)
    for (const sbx of fake.sandboxes) expect(leaksKey(sbx.runs.map((r) => [r.command, r.options.envs]))).toBe(false)
    // A client error that quotes the key is passed on with the key cut out.
    const failing = fakeClient()
    failing.loadClient.mockResolvedValue({
      Sandbox: {
        create: async () => {
          throw new Error(`401: key ${KEY} refused`)
        },
        connect: async () => {
          throw new Error(`503: ${KEY}`)
        },
        kill: async () => {
          throw new Error(`500: ${KEY}`)
        },
      },
    })
    const bad = implementation(failing)
    for (const attempt of [
      () => bad.start(CTX, { networkPolicy: 'deny-all' }, ARTIFACT),
      () => bad.resume(CTX, ARTIFACT, { sandboxId: 'sbx_x', version: 1 }),
      () => bad.onSessionEnd!(CTX, ARTIFACT, { sandboxId: 'sbx_x', version: 1 }, { reason: 'failed' }),
    ]) {
      const err = await attempt().then(
        () => null,
        (e: unknown) => e as Error,
      )
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain('[redacted]')
      expect(err!.message).not.toContain(KEY)
    }
  })
})

describe('the session on a runtime sandbox', () => {
  const session = (script?: (command: string) => Script) => {
    const calls: Call[] = []
    const sbx = new FakeSandbox('sbx_s', calls, script)
    return { sbx, calls, session: createRuntimeSession(sbx) }
  }
  const text = async (stream: ReadableStream<Uint8Array>) => new TextDecoder().decode(await new Response(stream).arrayBuffer())

  it('run(): the client\'s own `bash -l -c <command>`, in /workspace, with AI_AGENT=eve under the caller\'s env', async () => {
    const { sbx, session: s } = session(() => ({ stdout: ['out'], stderr: ['err'] }))
    expect(await s.run({ command: 'echo out; echo err >&2' })).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err' })
    await s.run({ command: 'pwd', workingDirectory: '/tmp', env: { AI_AGENT: 'other', FOO: 'bar' } })
    expect(sbx.runs[0].command).toBe('echo out; echo err >&2')
    expect(sbx.runs[0].options).toMatchObject({ background: true, cwd: '/workspace', envs: { AI_AGENT: 'eve' }, timeoutMs: 0 })
    expect(sbx.runs[1].options).toMatchObject({ cwd: '/tmp', envs: { AI_AGENT: 'other', FOO: 'bar' } })
  })

  it('a nonzero exit is a result, not an exception', async () => {
    const { session: s } = session(() => ({ stderr: ['nope\n'], exitCode: 3 }))
    expect(await s.run({ command: 'exit 3' })).toEqual({ exitCode: 3, stdout: '', stderr: 'nope\n' })
  })

  it('spawn(): byte streams that carry output before the exit, wait(), and kill()', async () => {
    const { sbx, session: s } = session((cmd) => (cmd === 'serve' ? { stdout: ['ready\n'], hang: true } : { stdout: ['a', 'b'] }))
    const proc = await s.spawn({ command: 'serve' })
    expect(proc.pid).toBe(100)
    const reader = proc.stdout.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('ready\n')
    await proc.kill()
    await proc.kill()
    expect(sbx.killedPids).toEqual([100])
    expect(await proc.wait()).toEqual({ exitCode: 137 })
    expect((await reader.read()).done).toBe(true)
    const other = await s.spawn({ command: 'x' })
    expect(await text(other.stdout)).toBe('ab')
    expect(await other.wait()).toEqual({ exitCode: 0 })
  })

  it('spawn() honours abortSignal: the process is killed and wait() rejects with the reason', async () => {
    const { sbx, session: s } = session(() => ({ hang: true }))
    const controller = new AbortController()
    const proc = await s.spawn({ command: 'sleep 100', abortSignal: controller.signal })
    controller.abort(new Error('stop it'))
    await expect(proc.wait()).rejects.toThrow('stop it')
    expect(sbx.killedPids).toEqual([100])
    const already = new AbortController()
    already.abort(new Error('too late'))
    await expect(s.spawn({ command: 'x', abortSignal: already.signal })).rejects.toThrow('too late')
    expect(sbx.runs).toHaveLength(1)
  })

  it('file methods: null for a missing file, relative paths under /workspace, overwrite, binary round trip', async () => {
    const { sbx, session: s } = session()
    expect(await s.readTextFile({ path: 'missing.txt' })).toBeNull()
    expect(await s.readBinaryFile({ path: '/nope' })).toBeNull()
    expect(await s.readFile({ path: 'missing' })).toBeNull()
    await s.writeTextFile({ path: 'deep/dir/a.txt', content: 'one' })
    await s.writeTextFile({ path: 'deep/dir/a.txt', content: 'two' })
    expect([...sbx.fs.keys()]).toEqual(['/workspace/deep/dir/a.txt'])
    expect(await s.readTextFile({ path: '/workspace/deep/dir/a.txt' })).toBe('two')
    const bytes = new Uint8Array([0, 255, 1, 128, 10, 13])
    await s.writeBinaryFile({ path: '/tmp/b.bin', content: bytes })
    expect(await s.readBinaryFile({ path: '/tmp/b.bin' })).toEqual(bytes)
    await s.writeFile({ path: 'c.bin', content: new Response(bytes).body! })
    expect(new Uint8Array(await new Response((await s.readFile({ path: 'c.bin' }))!).arrayBuffer())).toEqual(bytes)
    expect(s.resolvePath('x/y')).toBe('/workspace/x/y')
    expect(s.resolvePath('/etc/hosts')).toBe('/etc/hosts')
  })

  it('readTextFile: 1-based inclusive line ranges, past-EOF ends at EOF, encodings, bad ranges refused (as eve)', async () => {
    const { session: s } = session()
    await s.writeTextFile({ path: 'l.txt', content: 'a\nb\r\nc\rd' })
    expect(await s.readTextFile({ path: 'l.txt', startLine: 2, endLine: 3 })).toBe('b\r\nc\r')
    expect(await s.readTextFile({ path: 'l.txt', startLine: 4, endLine: 99 })).toBe('d')
    expect(await s.readTextFile({ path: 'l.txt', startLine: 9 })).toBe('')
    await expect(s.readTextFile({ path: 'l.txt', startLine: 0 })).rejects.toThrow(/startLine/)
    await expect(s.readTextFile({ path: 'l.txt', startLine: 3, endLine: 2 })).rejects.toThrow(/greater/)
    await s.writeTextFile({ path: 'latin.txt', content: 'café', encoding: 'latin1' })
    expect(await s.readBinaryFile({ path: 'latin.txt' })).toEqual(new Uint8Array([99, 97, 102, 233]))
    expect(await s.readTextFile({ path: 'latin.txt', encoding: 'latin1' })).toBe('café')
    await expect(s.readTextFile({ path: 'latin.txt' })).rejects.toThrow()
  })

  it('removePath: rm with -f / -r exactly as asked, and a failure throws', async () => {
    const { sbx, session: s } = session((cmd) => (cmd.includes('fail') ? { stderr: ['rm: cannot remove'], exitCode: 1 } : {}))
    await s.removePath({ path: 'dir', recursive: true, force: true })
    await s.removePath({ path: '/tmp/x' })
    expect(sbx.runs.map((r) => r.command)).toEqual(["rm -f -r -- '/workspace/dir'", "rm -- '/tmp/x'"])
    await expect(s.removePath({ path: 'fail' })).rejects.toThrow(/cannot remove/)
  })
})
