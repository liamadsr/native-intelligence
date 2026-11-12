/**
 * Conformance of the `ni-runtime` sandbox provider (../lib/runtime-sandbox.ts)
 * against a REAL runtime: the proof the unit tests (which use a fake client)
 * cannot give. It imports only the provider file, and through it eve's
 * provider helper and the real `e2b` client, and no other app code.
 *
 * It prints one `ok` or `FAIL` line per check and exits 1 if any failed (2 if
 * it could not start). Every sandbox it starts is killed before it exits,
 * failures and Ctrl-C included. It never prints the key.
 *
 * HOW TO RUN, from the `web` folder of a checkout whose dependencies are
 * installed (`npm ci`: it needs `tsx`, `eve` and `e2b`), on a machine that
 * reaches the runtime (the app's server, over the tunnel):
 *
 *   SANDBOX_RUNTIME_API_URL=http://<runtime tunnel address>:3000 \
 *   SANDBOX_RUNTIME_TRAFFIC_URL=http://<runtime tunnel address>:3002 \
 *   SANDBOX_RUNTIME_TEMPLATE=ni-coding-agent \
 *   SANDBOX_RUNTIME_KEY="$(<a command that prints the key from a root-only file>)" \
 *   npx tsx agents/coding-agent/scripts/runtime-conformance.mts
 *
 * The key is the runtime's own (`E2B_API_KEY` in the sandbox server's
 * /opt/e2b/sdk.env): bring it into the environment without showing it, never
 * by pasting it onto a command line that is echoed or kept in a history.
 * It needs outbound HTTPS from the sandboxes to github.com, raw.githubusercontent.com
 * and example.com, and curl in the template.
 */
import type { RuntimeConnection } from '../lib/runtime-sandbox.js'

// Loaded dynamically: tsx compiles the provider file as CommonJS (the web
// package is not "type": "module"), whose named exports a static ESM import
// cannot always see.
type Provider = typeof import('../lib/runtime-sandbox.js')
const { createRuntimeSandboxImplementation, loadRuntimeClient, SANDBOX_LIFETIME_MS } = (await import(
  '../lib/runtime-sandbox.js'
)) as Provider

type Impl = ReturnType<Provider['createRuntimeSandboxImplementation']>
type Handle = Awaited<ReturnType<Impl['resume']>>
type Policy = Parameters<Provider['runtimeNetworkOptions']>[0]

const env = (name: string) => process.env[name]?.trim() ?? ''
const apiUrl = env('SANDBOX_RUNTIME_API_URL')
const trafficUrl = env('SANDBOX_RUNTIME_TRAFFIC_URL')
const template = env('SANDBOX_RUNTIME_TEMPLATE') || 'ni-coding-agent'
const key = env('SANDBOX_RUNTIME_KEY')
if (!apiUrl || !trafficUrl || !key) {
  console.error('runtime-conformance: set SANDBOX_RUNTIME_API_URL, SANDBOX_RUNTIME_TRAFFIC_URL and SANDBOX_RUNTIME_KEY (see this file\'s header)')
  process.exit(2)
}

/** Any text this script prints, with the key cut out. */
const scrub = (text: string) => text.split(key).join('[redacted]')
const say = (line: string) => console.log(scrub(line))
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

let failures = 0
async function check(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await fn()
    say(`ok    ${name}${detail ? ` (${detail})` : ''}`)
    return true
  } catch (err) {
    failures++
    say(`FAIL  ${name}: ${messageOf(err)}`)
    return false
  }
}
function expect(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(what)
}

const options = { apiUrl, trafficUrl, template }
const impl = createRuntimeSandboxImplementation(options)
const ctx = { session: { id: `conformance-${Date.now()}` } } as never
const started = new Set<string>()

async function cleanup() {
  for (const sandboxId of started) {
    try {
      await impl.onSessionEnd!(ctx, { template }, { sandboxId, version: 1 }, { reason: 'completed' })
    } catch (err) {
      say(`FAIL  cleanup of ${sandboxId}: ${messageOf(err)}`)
      failures++
    }
  }
  started.clear()
}
process.on('SIGINT', () => {
  void cleanup().finally(() => process.exit(130))
})

async function start(policy: Policy): Promise<{ handle: Handle; sandboxId: string }> {
  const artifact = await impl.prepare({ resources: { source: { kind: 'none' } } } as never)
  const { handle, state } = await impl.start(ctx, { networkPolicy: policy }, artifact)
  started.add(state.sandboxId)
  return { handle, sandboxId: state.sandboxId }
}

/** curl's view of a URL from inside the sandbox: an HTTP status, or "000" when nothing answered. */
async function reach(handle: Handle, url: string): Promise<string> {
  const r = await handle.sandbox.run({ command: `curl -s -o /dev/null -m 10 -w '%{http_code}' '${url}' || true` })
  return r.stdout.trim() || '000'
}
const reached = (code: string) => code !== '000'

async function policies() {
  const cases: Array<{ name: string; policy: Policy; open: string[]; closed: string[] }> = [
    { name: 'deny-all', policy: 'deny-all', open: [], closed: ['https://github.com', 'https://example.com'] },
    { name: 'isolated-shaped list (github.com)', policy: { allow: { 'github.com': [] } }, open: ['https://github.com'], closed: ['https://example.com'] },
    {
      name: 'a list with a wildcard (*.githubusercontent.com)',
      policy: { allow: { 'github.com': [], '*.githubusercontent.com': [] } },
      open: ['https://raw.githubusercontent.com/', 'https://github.com'],
      closed: ['https://example.com'],
    },
    { name: "'*' (open internet)", policy: { allow: { '*': [] } }, open: ['https://example.com', 'https://github.com'], closed: [] },
  ]
  for (const c of cases) {
    let handle: Handle | undefined
    let sandboxId = ''
    const created = await check(`start with ${c.name}`, async () => {
      ;({ handle, sandboxId } = await start(c.policy))
      const curl = await handle.sandbox.run({ command: 'command -v curl' })
      expect(curl.exitCode === 0, 'the template has no curl, so reachability cannot be checked')
      return sandboxId
    })
    if (!created || !handle) continue
    for (const url of c.open) {
      await check(`${c.name}: ${url} reachable`, async () => {
        const code = await reach(handle!, url)
        expect(reached(code), `nothing answered (${code})`)
        return `HTTP ${code}`
      })
    }
    for (const url of c.closed) {
      await check(`${c.name}: ${url} NOT reachable`, async () => {
        const code = await reach(handle!, url)
        expect(!reached(code), `it answered HTTP ${code}`)
      })
    }
    await handle.onSandboxDelete()
    started.delete(sandboxId)
  }
  await check('a host with a header rule is refused before anything is created', async () => {
    const before = started.size
    const err = await start({ allow: { 'github.com': [{ transform: [{ headers: { authorization: 'x' } }] }] } } as Policy).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err && /carries rules/.test(err.message), 'it was not refused')
    expect(started.size === before, 'a sandbox was created')
  })
}

async function session(handle: Handle) {
  const s = handle.sandbox
  await check('run: exit codes', async () => {
    expect((await s.run({ command: 'true' })).exitCode === 0, 'true did not exit 0')
    const r = await s.run({ command: 'exit 3' })
    expect(r.exitCode === 3, `exit 3 gave ${r.exitCode}`)
  })
  await check('run: stdout and stderr apart', async () => {
    const r = await s.run({ command: 'echo out; echo err >&2' })
    expect(r.stdout === 'out\n' && r.stderr === 'err\n', `got ${JSON.stringify(r)}`)
  })
  await check('run: the working directory is /workspace, and another can be named', async () => {
    expect((await s.run({ command: 'pwd' })).stdout.trim() === '/workspace', 'not /workspace')
    expect((await s.run({ command: 'pwd', workingDirectory: '/tmp' })).stdout.trim() === '/tmp', 'workingDirectory ignored')
  })
  await check('run: $HOME is absolute, and the workspace is writable', async () => {
    const home = (await s.run({ command: 'printf %s "$HOME"' })).stdout
    expect(home.startsWith('/'), `HOME is ${JSON.stringify(home)}`)
    expect((await s.run({ command: 'touch .ni-w && rm .ni-w' })).exitCode === 0, '/workspace is not writable')
    return home
  })
  await check('run: AI_AGENT=eve, and a caller\'s env wins', async () => {
    expect((await s.run({ command: 'printf %s "$AI_AGENT"' })).stdout === 'eve', 'AI_AGENT is not eve')
    const r = await s.run({ command: 'printf %s:%s "$AI_AGENT" "$NI_X"', env: { AI_AGENT: 'other', NI_X: 'y' } })
    expect(r.stdout === 'other:y', `got ${r.stdout}`)
  })
  await check('run: a login shell that has sourced ~/.profile', async () => {
    expect((await s.run({ command: 'shopt -q login_shell' })).exitCode === 0, 'not a login shell')
    await s.run({ command: `printf '%s\\n' 'export NI_CONFORMANCE_PROFILE=1' >> "$HOME/.profile"` })
    const r = await s.run({ command: 'printf %s "$NI_CONFORMANCE_PROFILE"' })
    expect(r.stdout === '1', '~/.profile was not sourced (a ~/.bash_profile may shadow it)')
  })

  await check('spawn: output arrives before the exit, then wait()', async () => {
    const t0 = Date.now()
    const proc = await s.spawn({ command: 'echo first; sleep 3; echo second' })
    const reader = proc.stdout.getReader()
    const first = await reader.read()
    const firstAt = Date.now() - t0
    expect(new TextDecoder().decode(first.value).startsWith('first'), 'the first chunk is not "first"')
    const { exitCode } = await proc.wait()
    const doneAt = Date.now() - t0
    expect(exitCode === 0, `exit ${exitCode}`)
    expect(doneAt - firstAt >= 2000, `the first output came ${firstAt} ms in, the exit ${doneAt} ms in: not streamed`)
    return `first output at ${firstAt} ms, exit at ${doneAt} ms`
  })
  const alive = async (pid: number | undefined) => (await s.run({ command: `kill -0 ${pid} 2>/dev/null` })).exitCode === 0
  await check('spawn: kill()', async () => {
    const proc = await s.spawn({ command: 'sleep 120' })
    expect(typeof proc.pid === 'number', 'no pid')
    await proc.kill()
    const { exitCode } = await withTimeout(proc.wait(), 10_000, 'wait() after kill')
    expect(exitCode !== 0, 'a killed process exited 0')
    expect(!(await alive(proc.pid)), 'the process is still alive')
    return `exit ${exitCode}`
  })
  await check('spawn: abortSignal kills, and wait() rejects', async () => {
    const controller = new AbortController()
    const proc = await s.spawn({ command: 'sleep 120', abortSignal: controller.signal })
    controller.abort(new Error('aborted by the conformance check'))
    const err = await withTimeout(proc.wait(), 10_000, 'wait() after abort').then(() => null, (e: unknown) => e as Error)
    expect(err && /aborted by the conformance check/.test(err.message), 'wait() did not reject with the reason')
    await new Promise((r) => setTimeout(r, 1000))
    expect(!(await alive(proc.pid)), 'the process is still alive')
  })
  await check("a background job outlives the command that started it, and a later command sees and kills it (eve's bash tool)", async () => {
    // What eve's bash tool does with a long command: its own process group
    // (set -m), started from a command that then exits.
    const started = await s.run({ command: 'set -m; (trap : TERM INT; exec sleep 300) </dev/null >/dev/null 2>&1 & echo $!' })
    const pid = Number(started.stdout.trim())
    expect(started.exitCode === 0 && pid > 0, `could not start it: ${JSON.stringify(started)}`)
    await new Promise((r) => setTimeout(r, 1500))
    expect(await alive(pid), 'the job died with the command that started it')
    expect((await s.run({ command: `kill -- -${pid}` })).exitCode === 0, 'kill of its process group failed')
    await new Promise((r) => setTimeout(r, 1000))
    expect(!(await alive(pid)), 'the job is still alive after kill')
  })

  await check('files: a missing file is null, for every read method', async () => {
    expect((await s.readTextFile({ path: 'nope.txt' })) === null, 'readTextFile')
    expect((await s.readBinaryFile({ path: '/tmp/nope.bin' })) === null, 'readBinaryFile')
    expect((await s.readFile({ path: 'nope' })) === null, 'readFile')
  })
  await check('files: write creates parent directories and overwrites; relative paths are under /workspace', async () => {
    await s.writeTextFile({ path: 'ni-c/deep/a.txt', content: 'one' })
    await s.writeTextFile({ path: 'ni-c/deep/a.txt', content: 'two' })
    expect((await s.readTextFile({ path: '/workspace/ni-c/deep/a.txt' })) === 'two', 'not overwritten')
    expect((await s.run({ command: 'cat ni-c/deep/a.txt && test -w ni-c/deep/a.txt' })).stdout === 'two', 'not where a command looks, or not writable')
    expect(s.resolvePath('x') === '/workspace/x', 'resolvePath')
  })
  await check('files: binary round trip (every byte value), and a byte stream', async () => {
    const bytes = new Uint8Array(256 * 4).map((_, i) => i % 256)
    await s.writeBinaryFile({ path: '/tmp/ni-c.bin', content: bytes })
    const back = await s.readBinaryFile({ path: '/tmp/ni-c.bin' })
    expect(back && back.length === bytes.length && back.every((b, i) => b === bytes[i]), 'bytes differ')
    const size = (await s.run({ command: 'wc -c < /tmp/ni-c.bin' })).stdout.trim()
    expect(size === String(bytes.length), `size in the sandbox is ${size}`)
    await s.writeFile({ path: '/tmp/ni-c2.bin', content: new Response(bytes).body! })
    const stream = await s.readFile({ path: '/tmp/ni-c2.bin' })
    const streamed = new Uint8Array(await new Response(stream!).arrayBuffer())
    expect(streamed.length === bytes.length && streamed.every((b, i) => b === bytes[i]), 'stream bytes differ')
  })
  await check('files: line ranges and encodings', async () => {
    await s.writeTextFile({ path: 'ni-c/l.txt', content: 'a\nb\nc\n' })
    expect((await s.readTextFile({ path: 'ni-c/l.txt', startLine: 2, endLine: 9 })) === 'b\nc\n', 'line range')
    await s.writeTextFile({ path: 'ni-c/latin.txt', content: 'café', encoding: 'latin1' })
    expect((await s.run({ command: 'wc -c < ni-c/latin.txt' })).stdout.trim() === '4', 'latin1 not 4 bytes')
    expect((await s.readTextFile({ path: 'ni-c/latin.txt', encoding: 'latin1' })) === 'café', 'latin1 read')
  })
  await check('files: removePath honours force and recursive', async () => {
    await s.removePath({ path: 'ni-c/l.txt' })
    expect((await s.readTextFile({ path: 'ni-c/l.txt' })) === null, 'file not removed')
    await s.removePath({ path: 'ni-c/missing', force: true })
    const missing = await s.removePath({ path: 'ni-c/missing' }).then(() => null, (e: unknown) => e as Error)
    expect(missing, 'a missing path without force did not throw')
    const dir = await s.removePath({ path: 'ni-c' }).then(() => null, (e: unknown) => e as Error)
    expect(dir, 'a directory without recursive did not throw')
    await s.removePath({ path: 'ni-c', recursive: true })
    expect((await s.run({ command: 'test -e ni-c' })).exitCode !== 0, 'directory not removed')
  })
}

async function withTimeout<T>(promise: PromiseLike<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** The sandbox's end of life, as the runtime reports it (through the provider's own client). */
async function endsAt(sandboxId: string): Promise<number> {
  const client = (await loadRuntimeClient()) as unknown as {
    Sandbox: { getInfo(id: string, o: RuntimeConnection): Promise<{ endAt: Date | string }> }
  }
  const info = await client.Sandbox.getInfo(sandboxId, { apiKey: key, apiUrl, sandboxUrl: trafficUrl })
  return new Date(info.endAt).getTime()
}

async function lifecycle() {
  let handle: Handle | undefined
  let sandboxId = ''
  if (
    !(await check('start for the lifecycle checks, with a 60-minute lifetime', async () => {
      ;({ handle, sandboxId } = await start({ allow: { 'github.com': [] } }))
      const left = (await endsAt(sandboxId)) - Date.now()
      expect(Math.abs(left - SANDBOX_LIFETIME_MS) < 3 * 60_000, `it ends in ${Math.round(left / 60_000)} minutes`)
    }))
  )
    return
  await handle!.sandbox.writeTextFile({ path: 'ni-resume-marker', content: 'here' })

  await check('state → resume in a second provider instance, which pushes the lifetime out to 60 minutes', async () => {
    const client = (await loadRuntimeClient()) as unknown as {
      Sandbox: { setTimeout(id: string, ms: number, o: RuntimeConnection): Promise<void> }
    }
    await client.Sandbox.setTimeout(sandboxId, 5 * 60_000, { apiKey: key, apiUrl, sandboxUrl: trafficUrl })
    const short = (await endsAt(sandboxId)) - Date.now()
    expect(short < 10 * 60_000, `could not shorten it first (${Math.round(short / 60_000)} minutes)`)
    const second = createRuntimeSandboxImplementation(options)
    const resumed = await second.resume(ctx, { template }, { sandboxId, version: 1 })
    expect((await resumed.sandbox.readTextFile({ path: 'ni-resume-marker' })) === 'here', 'not the same sandbox')
    const left = (await endsAt(sandboxId)) - Date.now()
    expect(Math.abs(left - SANDBOX_LIFETIME_MS) < 3 * 60_000, `after resume it ends in ${Math.round(left / 60_000)} minutes`)
    return `ends in ${Math.round(left / 60_000)} minutes`
  })
  await check('runtime shutdown leaves the sandbox running', async () => {
    await handle!.onRuntimeShutdown()
    const second = createRuntimeSandboxImplementation(options)
    const resumed = await second.resume(ctx, { template }, { sandboxId, version: 1 })
    expect((await resumed.sandbox.run({ command: 'true' })).exitCode === 0, 'it does not run commands')
  })
  await check('delete, then resume throws (and starts nothing), then delete again is fine', async () => {
    await handle!.onSandboxDelete()
    const second = createRuntimeSandboxImplementation(options)
    const err = await second.resume(ctx, { template }, { sandboxId, version: 1 }).then(() => null, (e: unknown) => e as Error)
    expect(err && /no longer exists/.test(err.message), `resume did not say it is gone: ${err ? err.message : 'it resumed'}`)
    await handle!.onSandboxDelete()
    await impl.onSessionEnd!(ctx, { template }, { sandboxId, version: 1 }, { reason: 'completed' })
    started.delete(sandboxId)
  })
}

try {
  say(`runtime-conformance: ${apiUrl} (traffic ${trafficUrl}), template ${template}`)
  await policies()
  let handle: Handle | undefined
  if (
    await check('start a sandbox for the session checks (open internet)', async () => {
      ;({ handle } = await start({ allow: { '*': [] } }))
    })
  ) {
    await session(handle!)
  }
  await lifecycle()
} catch (err) {
  failures++
  say(`FAIL  the run stopped: ${messageOf(err)}`)
} finally {
  await cleanup()
}
say(failures === 0 ? 'runtime-conformance: every check passed' : `runtime-conformance: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
