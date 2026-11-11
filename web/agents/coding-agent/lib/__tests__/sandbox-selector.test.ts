/**
 * Sandbox SELECTOR tests for the coding-agent (eve 0.64+ provider-environment
 * model — see sandbox.ts's header).
 *
 * The security-critical invariant: on Vercel the session sandbox is OPENED with
 * the run's network policy (egress narrowed to RESTRICTED_ALLOW_HOSTS for a
 * `restricted` run, the GitHub credential brokered at the firewall), so the
 * policy is part of sandbox creation and precedes every command — the clone
 * included. With no spec the sandbox opens `deny-all`, and the environment
 * itself carries a `deny-all` baseline (which only covers an ABSENT key — the
 * selector therefore never opens without a defined policy). Off Vercel the same
 * policy is applied through the provider's setter; when it cannot be, any run
 * but a `trusted` one (restricted, isolated, unknown) fails closed unless this
 * is an interactive eve dev session (EVE_DEV=1 and not an `eve eval`, which
 * sets EVE_EVALUATION=1). An `isolated` run opens with github.com only. Every
 * git setup step must exit 0 or the selector throws.
 *
 * User env values (often registry tokens) must reach no recorded command and
 * no command env either: they go through the file API and are sourced.
 *
 * The GitHub token: on Vercel it is brokered for reads only, so it must appear
 * in NO command string, NO env and NO remote URL. Off Vercel it travels only
 * as the clone's one-shot env, and is NEVER persisted (a persisted GitHub
 * credential could push the live branch). Pushes go to the app's push gate
 * (remote.origin.pushurl), the only place a push can authenticate.
 *
 * Every describe pins `VERCEL` explicitly: sandbox.ts reads it at module load,
 * and Vercel's build env (where `npm run build` runs this suite) sets VERCEL=1.
 *
 * The provider SDKs are mocked; what is under test is what this module asks eve
 * for. (That eve's Vercel provider passes `open()`'s networkPolicy into
 * Sandbox.create for a snapshot-backed session is proven from eve's source in
 * the sandbox.ts header, and needs a live Vercel run to observe end to end.)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TOKEN = 'gho_exampletoken1234567890'

const SPEC = {
  systemPrompt: 'p',
  taskPrompt: 't',
  model: 'anthropic/claude-sonnet-4.5',
  repoFullName: 'acme/app',
  baseBranch: 'main',
  branchName: 'dial8/fix-1',
  networkAccess: 'restricted' as const,
  setupScript: null,
  envVars: {},
  githubToken: TOKEN,
  gitPushToken: 'push.tokenexample',
}

const PUSH_URL = 'https://app-abc123.vercel.app/api/internal/agent-run/git'
const PUSH_HOST = 'app-abc123.vercel.app'
/** What the mocked gitPushUrl answers (null = on Vercel with no public origin). */
let pushUrlNow: string | null = PUSH_URL

const selectorCtx = {
  session: {
    auth: { current: { attributes: { runToken: 'signed.run.token' } } },
    id: 'wrun_TEST',
    turn: { id: 'turn_0' },
  },
}

type Call = {
  kind: 'open' | 'run' | 'setNetworkPolicy' | 'writeTextFile'
  arg: unknown
  env?: Record<string, string>
}

const SANDBOX_HOME = '/home/vercel-sandbox'

type FakeOpts = {
  setNetworkPolicy?: 'ok' | 'throws' | 'absent'
  /** Exit code + stderr for the first command matching `match`. */
  fail?: { match: RegExp; exitCode: number; stderr: string; /** Fail only this many matches (default: all). */ times?: number }
}

function fakeSandbox(calls: Call[], opts?: FakeOpts) {
  const sandbox: Record<string, unknown> = {
    run: vi.fn(async (a: { command: string; env?: Record<string, string> }) => {
      calls.push({ kind: 'run', arg: a.command, ...(a.env ? { env: a.env } : {}) })
      if (opts?.fail && opts.fail.match.test(a.command) && (opts.fail.times === undefined || opts.fail.times-- > 0)) {
        return { exitCode: opts.fail.exitCode, stdout: '', stderr: opts.fail.stderr }
      }
      if (a.command === 'printf %s "$HOME"') return { exitCode: 0, stdout: SANDBOX_HOME, stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }),
    writeTextFile: vi.fn(async (a: { path: string; content: string }) => {
      calls.push({ kind: 'writeTextFile', arg: a })
    }),
  }
  if (opts?.setNetworkPolicy !== 'absent') {
    sandbox.setNetworkPolicy = vi.fn(async (p: unknown) => {
      calls.push({ kind: 'setNetworkPolicy', arg: p })
      if (opts?.setNetworkPolicy === 'throws') throw new Error('docker: record-form policy unsupported')
    })
  }
  return sandbox
}

/** The token in any form a leak could take: raw, or inside the Basic credential. */
const BASIC = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64')
const leaksToken = (text: string) => text.includes(TOKEN) || text.includes(BASIC)
const PUSH_BASIC = Buffer.from('x-access-token:push.tokenexample', 'utf8').toString('base64')
const leaksPushToken = (text: string) => text.includes('push.tokenexample') || text.includes(PUSH_BASIC)
const runCommands = (calls: Call[]) => calls.filter((c) => c.kind === 'run').map((c) => String(c.arg))
const runEnvs = (calls: Call[]) => calls.filter((c) => c.kind === 'run').map((c) => JSON.stringify(c.env ?? {}))

const fetchEveSpec = vi.fn()
const postEvent = vi.fn(async () => ({ canceling: false }))
const beats = () => postEvent.mock.calls.map((c) => String((c as unknown[])[2]))

async function loadSandboxModule() {
  vi.doMock('../spec-client', () => ({
    fetchEveSpec,
    postEvent,
    gitPushUrl: () => pushUrlNow,
    runTokenFromAuth: (auth: { current?: { attributes?: { runToken?: unknown } } }) =>
      typeof auth.current?.attributes?.runToken === 'string' ? auth.current.attributes.runToken : '',
  }))
  return await import('../../sandbox')
}

beforeEach(() => {
  pushUrlNow = PUSH_URL
  // No hosted-sandbox settings unless a test sets them (they choose the provider
  // off Vercel; a developer's shell must not change what these tests see).
  vi.stubEnv('SANDBOX_ACCESS_TOKEN', '')
  vi.stubEnv('SANDBOX_TEAM_ID', '')
  vi.stubEnv('SANDBOX_PROJECT_ID', '')
  vi.resetModules()
  fetchEveSpec.mockReset()
  postEvent.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock('eve/sandbox/vercel')
  vi.doUnmock('eve/sandbox')
  vi.doUnmock('../spec-client')
})

describe('coding-agent sandbox selector — on Vercel', () => {
  function mockVercel(calls: Call[], fake?: FakeOpts) {
    const envOptions: unknown[] = []
    const env = {
      provider: 'vercel',
      open: vi.fn(async (o: unknown) => {
        calls.push({ kind: 'open', arg: o })
        return fakeSandbox(calls, fake)
      }),
    }
    vi.doMock('eve/sandbox/vercel', () => ({
      VercelSandbox: {
        environment: (o: unknown) => {
          envOptions.push(o)
          return env
        },
      },
    }))
    return { env, envOptions }
  }

  it('exports a dedicated Vercel environment with a deny-all baseline', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    const { env, envOptions } = mockVercel(calls)
    const mod = await loadSandboxModule()
    expect(mod.environment).toBe(env)
    expect(envOptions).toEqual([{ networkPolicy: 'deny-all' }])
  })

  it('restricted run: OPENS with the RESTRICTED_ALLOW_HOSTS policy (+ brokered github credential) before any command', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls)
    fetchEveSpec.mockResolvedValue(SPEC)
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    expect(fetchEveSpec).toHaveBeenCalledWith('signed.run.token')
    expect(calls[0]).toEqual({
      kind: 'open',
      arg: {
        networkPolicy: mod.buildNetworkPolicy('restricted', {
          repoFullName: 'acme/app',
          pushUrl: PUSH_URL,
          broker: { githubToken: TOKEN, pushToken: 'push.tokenexample' },
        }),
      },
    })
    const opened = calls[0].arg as { networkPolicy: { allow: Record<string, unknown> } }
    expect(Object.keys(opened.networkPolicy.allow).sort()).toEqual([...mod.RESTRICTED_ALLOW_HOSTS, PUSH_HOST].sort())
    expect(Object.keys(opened.networkPolicy.allow)).not.toContain('*')
    // Every command (the clone first) runs strictly after the policied open.
    const runs = calls.filter((c) => c.kind === 'run')
    expect(runs.length).toBeGreaterThan(0)
    expect(String(runs[0].arg)).toContain('git clone')
    expect(calls.findIndex((c) => c.kind === 'run')).toBeGreaterThan(0)
    // No imperative re-policy on Vercel — the policy is a creation option.
    expect(calls.some((c) => c.kind === 'setNetworkPolicy')).toBe(false)
  })

  it('never opens without a DEFINED networkPolicy, whatever the spec (an explicit undefined would override the deny-all baseline)', async () => {
    vi.stubEnv('VERCEL', '1')
    const specs: Array<typeof SPEC | null> = [
      SPEC,
      { ...SPEC, networkAccess: 'trusted' as never },
      { ...SPEC, networkAccess: 'isolated' as never },
      { ...SPEC, networkAccess: 'something-new' as never },
      null,
    ]
    for (const spec of specs) {
      vi.resetModules()
      const calls: Call[] = []
      mockVercel(calls)
      fetchEveSpec.mockResolvedValue(spec)
      const mod = await loadSandboxModule()
      await mod.default(selectorCtx as never)
      const opens = calls.filter((c) => c.kind === 'open')
      expect(opens).toHaveLength(1)
      const arg = opens[0].arg as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(arg, 'networkPolicy')).toBe(true)
      expect(arg.networkPolicy).toBeDefined()
      expect(arg.networkPolicy).not.toBeNull()
    }
  })

  it('the GitHub token is in no command string, no env and no remote: the clone uses the bare github.com URL (the firewall injects the credential)', async () => {
    for (const networkAccess of ['restricted', 'trusted'] as const) {
      vi.resetModules()
      vi.stubEnv('VERCEL', '1')
      const calls: Call[] = []
      mockVercel(calls)
      fetchEveSpec.mockResolvedValue({ ...SPEC, networkAccess })
      const mod = await loadSandboxModule()
      await mod.default(selectorCtx as never)

      const commands = runCommands(calls)
      expect(commands[0]).toContain(`'https://github.com/acme/app.git'`)
      expect(commands.some(leaksToken)).toBe(false)
      expect(runEnvs(calls).some(leaksToken)).toBe(false)
      expect(commands.some(leaksPushToken)).toBe(false)
      expect(runEnvs(calls).some(leaksPushToken)).toBe(false)
      expect(commands.some((c) => c.includes('extraheader'))).toBe(false)
    }
  })

  it('every push goes to the app\'s push gate: pushurl is set before the checkout, and LFS stays on GitHub', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls)
    fetchEveSpec.mockResolvedValue(SPEC)
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    const commands = runCommands(calls)
    const pushurl = commands.indexOf(`git config remote.origin.pushurl '${PUSH_URL}'`)
    expect(pushurl).toBeGreaterThan(0)
    expect(pushurl).toBeLessThan(commands.findIndex((c) => c.startsWith('git checkout -b')))
    expect(commands).toContain(`git config lfs.url 'https://github.com/acme/app.git/info/lfs'`)
    // The hook is told the gate's URL (git hands it the push URL).
    expect(commands).toContain(mod.installPushGuardCommand({ home: SANDBOX_HOME, branchName: 'dial8/fix-1', remoteUrl: PUSH_URL }))
  })

  it("no public app origin (NEXT_PUBLIC_APP_URL unset on Vercel): refused before anything opens, and the person is told why", async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls)
    pushUrlNow = null
    fetchEveSpec.mockResolvedValue(SPEC)
    const mod = await loadSandboxModule()

    await expect(mod.default(selectorCtx as never)).rejects.toThrow(/NEXT_PUBLIC_APP_URL is not set/)
    expect(calls).toEqual([])
    expect(beats().some((b) => b.includes('NEXT_PUBLIC_APP_URL') && b.startsWith('Refusing to run'))).toBe(true)
  })

  it('a spec with no push credential is refused before anything opens', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls)
    const { gitPushToken: _drop, ...noPush } = SPEC
    fetchEveSpec.mockResolvedValue(noPush)
    const mod = await loadSandboxModule()

    await expect(mod.default(selectorCtx as never)).rejects.toThrow(/no push credential/)
    expect(calls).toEqual([])
  })

  it('isolated run: OPENS with github.com + the push gate ONLY (no "*", no npm) — the tightest policy that still clones and pushes', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls)
    fetchEveSpec.mockResolvedValue({ ...SPEC, networkAccess: 'isolated' })
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    const opened = calls[0].arg as { networkPolicy: { allow: Record<string, unknown> } }
    expect(calls[0].kind).toBe('open')
    expect(Object.keys(opened.networkPolicy.allow).sort()).toEqual([PUSH_HOST, 'github.com'])
  })

  it('the brokered GitHub credential is read-only and scoped to the run\'s repo in the policy the sandbox is opened with', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls)
    fetchEveSpec.mockResolvedValue(SPEC)
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    const opened = calls[0].arg as { networkPolicy: { allow: Record<string, unknown> } }
    expect(opened.networkPolicy.allow['github.com']).toEqual(mod.githubReadRules(TOKEN, 'acme/app'))
    expect(JSON.stringify(opened.networkPolicy.allow['github.com'])).not.toContain('receive-pack')
  })

  it('a FAILED clone throws (eve deletes the sandbox) instead of announcing a ready sandbox over an empty /workspace', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls, {
      fail: {
        match: /^git clone/,
        exitCode: 128,
        stderr: `remote: Repository not found.\nfatal: Authentication failed (Basic ${BASIC}) ${TOKEN}`,
      },
    })
    fetchEveSpec.mockResolvedValue(SPEC)
    const mod = await loadSandboxModule()

    const err = await Promise.resolve(mod.default(selectorCtx as never)).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/git clone of acme\/app@main failed \(exit 128\)/)
    expect(err!.message).toContain('Repository not found')
    // Nothing after the clone ran, and no "Sandbox ready" was announced.
    expect(runCommands(calls)).toHaveLength(1)
    expect(beats().some((b) => b.startsWith('Sandbox ready'))).toBe(false)
    expect(beats().some((b) => b.includes('git clone of acme/app@main failed (exit 128)'))).toBe(true)
    // The quoted stderr never carries the credential, in either form.
    expect(leaksToken(err!.message)).toBe(false)
    expect(beats().some(leaksToken)).toBe(false)
  })

  it('a failed branch checkout also throws', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls, { fail: { match: /^git checkout -b/, exitCode: 128, stderr: 'fatal: a branch named x already exists' } })
    fetchEveSpec.mockResolvedValue(SPEC)
    const mod = await loadSandboxModule()

    await expect(mod.default(selectorCtx as never)).rejects.toThrow(/git checkout -b dial8\/fix-1 failed \(exit 128\)/)
    expect(beats().some((b) => b.startsWith('Sandbox ready'))).toBe(false)
  })

  it('a CI fix run (startFrom) forks a side branch from the PR branch, never from base, and never checks out the PR branch itself (P10 F7)', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls)
    fetchEveSpec.mockResolvedValue({ ...SPEC, branchName: 'dial8/fix-1-cifix-abcd1234', startFrom: 'dial8/fix-1' })
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    const commands = runCommands(calls)
    expect(commands).toContain("git fetch --depth 50 origin 'refs/heads/dial8/fix-1:refs/remotes/origin/dial8/fix-1'")
    expect(commands).toContain("git checkout -b 'dial8/fix-1-cifix-abcd1234' 'origin/dial8/fix-1'")
    expect(commands.indexOf("git checkout -b 'dial8/fix-1-cifix-abcd1234' 'origin/dial8/fix-1'")).toBeGreaterThan(
      commands.indexOf("git fetch --depth 50 origin 'refs/heads/dial8/fix-1:refs/remotes/origin/dial8/fix-1'"),
    )
    expect(commands.some((c) => c === "git checkout -b 'dial8/fix-1'")).toBe(false)
    expect(beats().some((b) => b.startsWith('Sandbox ready'))).toBe(true)
  })

  it('user env values reach NO recorded command and NO command env: written by the file API, then sourced by fixed text', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls)
    const secretValue = "npm_s3cr3t'value$(whoami)"
    fetchEveSpec.mockResolvedValue({
      ...SPEC,
      envVars: { NPM_TOKEN: secretValue, API_BASE: 'https://registry.example.com/private' },
      setupScript: 'npm ci',
    })
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    const leaksUserEnv = (text: string) => text.includes('npm_s3cr3t') || text.includes('registry.example.com')
    expect(runCommands(calls).some(leaksUserEnv)).toBe(false)
    expect(runEnvs(calls).some(leaksUserEnv)).toBe(false)
    // The values went through the file API, into $HOME (outside /workspace, so
    // they can never be committed).
    const writes = calls.filter((c) => c.kind === 'writeTextFile').map((c) => c.arg as { path: string; content: string })
    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe(`${SANDBOX_HOME}/.dial8_env`)
    expect(writes[0].content).toContain(`export NPM_TOKEN='npm_s3cr3t'\\''value$(whoami)'`)
    expect(writes[0].content).toContain(`export API_BASE='https://registry.example.com/private'`)
    // The login-shell startup files source it (eve runs `bash -lc`), and the
    // setup script sources it first — no env passed.
    const commands = runCommands(calls)
    expect(commands).toContain(mod.envHookCommand('.dial8_env'))
    const setupRun = calls.find((c) => c.kind === 'run' && String(c.arg).endsWith('npm ci'))
    expect(setupRun).toBeDefined()
    expect(String(setupRun!.arg)).toBe('. "$HOME/.dial8_env"\nnpm ci')
    expect(setupRun!.env).toBeUndefined()
    // The file is written before anything sources it.
    const writeIdx = calls.findIndex((c) => c.kind === 'writeTextFile')
    const hookIdx = calls.findIndex((c) => c.kind === 'run' && c.arg === mod.envHookCommand('.dial8_env'))
    expect(writeIdx).toBeLessThan(hookIdx)
  })

  it('no user env: writes no env file and runs the setup script as-is', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls)
    fetchEveSpec.mockResolvedValue({ ...SPEC, setupScript: 'npm ci' })
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    expect(calls.some((c) => c.kind === 'writeTextFile')).toBe(false)
    expect(runCommands(calls)).toContain('npm ci')
  })

  it('installs the push guard right after the branch checkout, before the user env, the setup script or any model command', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls)
    fetchEveSpec.mockResolvedValue({ ...SPEC, envVars: { A: '1' }, setupScript: 'npm ci' })
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    const commands = runCommands(calls)
    const guard = { home: SANDBOX_HOME, branchName: 'dial8/fix-1', remoteUrl: PUSH_URL }
    const install = mod.installPushGuardCommand(guard)
    const pin = mod.envHookCommand(mod.GIT_PIN_FILE)
    const verify = mod.pushGuardCheckCommand(guard)
    const checkoutIdx = commands.findIndex((c) => c.startsWith('git checkout -b'))
    expect(commands.slice(checkoutIdx + 1, checkoutIdx + 5)).toEqual(['printf %s "$HOME"', install, pin, verify])
    // A first plain `git push` sets the upstream.
    expect(commands.indexOf('git config push.autoSetupRemote true')).toBeLessThan(checkoutIdx)
    // All of it before the user env file and the setup script.
    expect(calls.findIndex((c) => c.kind === 'run' && c.arg === verify)).toBeLessThan(
      calls.findIndex((c) => c.kind === 'writeTextFile'),
    )
    expect(commands.indexOf(verify)).toBeLessThan(commands.findIndex((c) => c.endsWith('npm ci')))
    // After the setup script, the guard is verified again.
    expect(commands.at(-1)).toBe(verify)
    expect(commands.filter((c) => c === install)).toHaveLength(1)
    expect(beats().some((b) => b.startsWith('Push guard'))).toBe(false)
    expect(beats().some((b) => b.startsWith('Sandbox ready'))).toBe(true)
  })

  it('the guard files and the hooks-path pin live in $HOME, outside /workspace and .git', async () => {
    vi.stubEnv('VERCEL', '1')
    const mod = await loadSandboxModule()
    const cmd = mod.installPushGuardCommand({ home: SANDBOX_HOME, branchName: 'dial8/fix-1', remoteUrl: 'x' })
    expect(cmd).toContain(`'${SANDBOX_HOME}/.dial8-hooks/pre-push'`)
    expect(cmd).toContain(`'${SANDBOX_HOME}/.dial8_git'`)
    expect(cmd).not.toContain('.git/hooks')
    expect(mod.gitHooksPinFile(`${SANDBOX_HOME}/.dial8-hooks`)).toBe(
      `export GIT_CONFIG_COUNT=1\nexport GIT_CONFIG_KEY_0=core.hooksPath\nexport GIT_CONFIG_VALUE_0='${SANDBOX_HOME}/.dial8-hooks'\n`,
    )
  })

  it('a failed guard install throws: no run starts without the guard', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls, { fail: { match: /^mkdir -p .*\.dial8-hooks/, exitCode: 1, stderr: 'read-only' } })
    fetchEveSpec.mockResolvedValue(SPEC)
    const mod = await loadSandboxModule()

    await expect(mod.default(selectorCtx as never)).rejects.toThrow(/install the push guard failed \(exit 1\)/)
    expect(beats().some((b) => b.startsWith('Sandbox ready'))).toBe(false)
  })

  it('a guard not in force after the setup script is reinstalled once, and the run goes on when that holds', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    // The first check (after install) passes; the one after the setup script fails once.
    let checks = 0
    mockVercel(calls, {
      fail: { match: { test: (c: string) => c.includes('git hash-object --stdin') && ++checks === 2 } as unknown as RegExp, exitCode: 1, stderr: '' },
    })
    fetchEveSpec.mockResolvedValue({ ...SPEC, setupScript: 'npx husky' })
    const mod = await loadSandboxModule()
    const guard = { home: SANDBOX_HOME, branchName: 'dial8/fix-1', remoteUrl: PUSH_URL }

    await mod.default(selectorCtx as never)

    const commands = runCommands(calls)
    expect(checks).toBe(3)
    expect(commands.filter((c) => c === mod.installPushGuardCommand(guard))).toHaveLength(2)
    expect(beats().some((b) => b.includes('reinstalled it'))).toBe(true)
    expect(beats().some((b) => b.startsWith('Sandbox ready'))).toBe(true)
  })

  it('a guard that stays out of force fails the run (never a warning only)', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls, { fail: { match: /git hash-object --stdin/, exitCode: 1, stderr: '' } })
    fetchEveSpec.mockResolvedValue({ ...SPEC, setupScript: 'npx husky' })
    const mod = await loadSandboxModule()

    await expect(mod.default(selectorCtx as never)).rejects.toThrow(/push guard is not in force after install/)
    expect(beats().some((b) => b.includes('refusing to run'))).toBe(true)
    expect(beats().some((b) => b.startsWith('Sandbox ready'))).toBe(false)
    // It never got as far as the setup script.
    expect(runCommands(calls).some((c) => c.endsWith('npx husky'))).toBe(false)
  })

  it('only an interactive eve dev session goes on without the guard (with a beat); an eval does not', async () => {
    for (const evaluation of [false, true]) {
      vi.resetModules()
      vi.stubEnv('VERCEL', '1')
      vi.stubEnv('EVE_DEV', '1')
      if (evaluation) vi.stubEnv('EVE_EVALUATION', '1')
      postEvent.mockClear()
      const calls: Call[] = []
      mockVercel(calls, { fail: { match: /git hash-object --stdin/, exitCode: 1, stderr: '' } })
      fetchEveSpec.mockResolvedValue(SPEC)
      const mod = await loadSandboxModule()
      const run = Promise.resolve(mod.default(selectorCtx as never))
      if (evaluation) {
        await expect(run).rejects.toThrow(/push guard is not in force/)
      } else {
        await run
        expect(beats().some((b) => b.includes('dev only: continuing without it'))).toBe(true)
      }
      vi.unstubAllEnvs()
    }
  })

  it('refuses a spec whose working branch IS the base branch, before cloning', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls)
    fetchEveSpec.mockResolvedValue({ ...SPEC, branchName: 'main' })
    const mod = await loadSandboxModule()

    await expect(mod.default(selectorCtx as never)).rejects.toThrow(/working branch must differ from the base branch/)
    expect(runCommands(calls)).toHaveLength(0)
  })

  it('no spec (unknown/expired token): opens deny-all and runs nothing', async () => {
    vi.stubEnv('VERCEL', '1')
    const calls: Call[] = []
    mockVercel(calls)
    fetchEveSpec.mockResolvedValue(null)
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    expect(calls).toEqual([{ kind: 'open', arg: { networkPolicy: 'deny-all' } }])
  })
})

describe('coding-agent sandbox selector — off Vercel', () => {
  beforeEach(() => {
    // Off Vercel regardless of the host env (Vercel's build env sets VERCEL=1;
    // Boolean('') is false). And never let the real Vercel provider load.
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('EVE_DEV', '')
    vi.stubEnv('EVE_EVALUATION', '')
    vi.doMock('eve/sandbox/vercel', () => ({
      VercelSandbox: {
        environment: () => {
          throw new Error('the Vercel provider must not be constructed off Vercel')
        },
      },
    }))
  })

  function mockDefault(calls: Call[], setNetworkPolicy: 'ok' | 'throws' | 'absent', fake?: Omit<FakeOpts, 'setNetworkPolicy'>) {
    vi.doMock('eve/sandbox', async (importOriginal) => {
      const actual = await importOriginal<typeof import('eve/sandbox')>()
      return {
        ...actual,
        DefaultSandbox: {
          name: 'default',
          environment: () => ({
            provider: 'microsandbox',
            open: vi.fn(async (o?: unknown) => {
              calls.push({ kind: 'open', arg: o })
              return fakeSandbox(calls, { setNetworkPolicy, ...fake })
            }),
          }),
        },
      }
    })
  }

  it('applies the run policy through the provider setter, with NO credential in it (microsandbox ignores a rule\'s match and stores the policy on disk)', async () => {
    const calls: Call[] = []
    mockDefault(calls, 'ok')
    fetchEveSpec.mockResolvedValue(SPEC)
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    expect(calls[0]).toEqual({ kind: 'open', arg: undefined })
    expect(calls[1]).toEqual({
      kind: 'setNetworkPolicy',
      arg: mod.buildNetworkPolicy('restricted', { repoFullName: 'acme/app', pushUrl: PUSH_URL, broker: null }),
    })
    expect(JSON.stringify(calls[1].arg)).not.toContain('Basic')
    expect(calls[2].kind).toBe('run')
    // The token appears in no command; only the clone's one-shot env carries it.
    expect(runCommands(calls)[0]).toContain(`'https://github.com/acme/app.git'`)
    expect(runCommands(calls).some(leaksToken)).toBe(false)
    const withToken = calls.filter((c) => c.kind === 'run' && leaksToken(JSON.stringify(c.env ?? {})))
    expect(withToken.map((c) => String(c.arg))).toEqual([runCommands(calls)[0]])
  })

  it('no policy could be applied (trusted run, just-bash): the token travels ONLY as env values — never in a command string or the remote', async () => {
    const calls: Call[] = []
    mockDefault(calls, 'absent')
    fetchEveSpec.mockResolvedValue({ ...SPEC, networkAccess: 'trusted' })
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    const runs = calls.filter((c) => c.kind === 'run')
    expect(runCommands(calls).some(leaksToken)).toBe(false)
    // The clone: bare remote + a one-shot git-config env carrying the header.
    expect(String(runs[0].arg)).toContain(`'https://github.com/acme/app.git'`)
    expect(runs[0].env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${BASIC}`,
      GIT_TERMINAL_PROMPT: '0',
    })
    // NEVER persisted: no later command gets it (a persisted GitHub
    // credential could push the live branch), and no config names github.com's
    // extraheader.
    expect(runs.slice(1).some((r) => leaksToken(JSON.stringify(r.env ?? {})))).toBe(false)
    expect(runCommands(calls).some((c) => c.includes('http.https://github.com/.extraheader'))).toBe(false)
    // The push token is kept for the push URL only, by env REFERENCE.
    expect(runs).toContainEqual({
      kind: 'run',
      arg: `git config '${'http.' + PUSH_URL + '.extraheader'}' "$NI_PUSH_AUTH_HEADER"`,
      env: { NI_PUSH_AUTH_HEADER: `Authorization: Basic ${PUSH_BASIC}` },
    })
    expect(runCommands(calls).some(leaksPushToken)).toBe(false)
  })

  it('no spec: applies deny-all through the setter too (a no-spec sandbox never keeps the provider default)', async () => {
    const calls: Call[] = []
    mockDefault(calls, 'ok')
    fetchEveSpec.mockResolvedValue(null)
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    expect(calls).toEqual([
      { kind: 'open', arg: undefined },
      { kind: 'setNetworkPolicy', arg: 'deny-all' },
    ])
  })

  it('no spec and the provider cannot take deny-all: does not throw, says so, and still runs nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const calls: Call[] = []
      mockDefault(calls, 'absent')
      fetchEveSpec.mockResolvedValue(null)
      const mod = await loadSandboxModule()

      await mod.default(selectorCtx as never)

      expect(calls.some((c) => c.kind === 'run')).toBe(false)
      expect(warn).toHaveBeenCalled()
      expect(beats().some((b) => b.includes('no network-policy support') && b.includes('no run spec'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    ['rejects the policy (Docker)', 'throws' as const, 'Network policy not applied'],
    ['has no setter (just-bash)', 'absent' as const, 'no network-policy support'],
  ])('restricted run, provider %s, NOT eve dev: FAILS CLOSED before any command (no clone with open egress)', async (_label, mode, reason) => {
    const calls: Call[] = []
    mockDefault(calls, mode)
    fetchEveSpec.mockResolvedValue(SPEC)
    const mod = await loadSandboxModule()

    await expect(mod.default(selectorCtx as never)).rejects.toThrow(/restricted run cannot proceed/)
    expect(calls.some((c) => c.kind === 'run')).toBe(false)
    expect(beats().some((b) => b.includes(reason) && b.includes('refusing'))).toBe(true)
  })

  it.each([
    ['rejects the policy (Docker)', 'throws' as const, 'Network policy not applied'],
    ['has no setter (just-bash)', 'absent' as const, 'no network-policy support'],
  ])('restricted run, provider %s, under eve dev (EVE_DEV=1): degrades loudly, never silently', async (_label, mode, reason) => {
    vi.stubEnv('EVE_DEV', '1')
    const calls: Call[] = []
    mockDefault(calls, mode)
    fetchEveSpec.mockResolvedValue(SPEC)
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    expect(beats().some((b) => b.includes(reason) && b.includes('egress is unrestricted'))).toBe(true)
    expect(calls.some((c) => c.kind === 'run')).toBe(true)
  })

  it.each([
    ['rejects the policy (Docker)', 'throws' as const],
    ['has no setter (just-bash)', 'absent' as const],
  ])('restricted run, provider %s, under `eve eval` (EVE_DEV=1 AND EVE_EVALUATION=1): still FAILS CLOSED', async (_label, mode) => {
    vi.stubEnv('EVE_DEV', '1')
    vi.stubEnv('EVE_EVALUATION', '1')
    const calls: Call[] = []
    mockDefault(calls, mode)
    fetchEveSpec.mockResolvedValue(SPEC)
    const mod = await loadSandboxModule()

    await expect(mod.default(selectorCtx as never)).rejects.toThrow(/restricted run cannot proceed/)
    expect(calls.some((c) => c.kind === 'run')).toBe(false)
  })

  it.each([
    ['rejects the policy (Docker)', 'throws' as const],
    ['has no setter (just-bash)', 'absent' as const],
  ])('isolated run, provider %s, NOT eve dev: FAILS CLOSED like restricted', async (_label, mode) => {
    const calls: Call[] = []
    mockDefault(calls, mode)
    fetchEveSpec.mockResolvedValue({ ...SPEC, networkAccess: 'isolated' })
    const mod = await loadSandboxModule()

    await expect(mod.default(selectorCtx as never)).rejects.toThrow(/isolated run cannot proceed/)
    expect(calls.some((c) => c.kind === 'run')).toBe(false)
  })

  it('an unknown networkAccess value fails closed too (only trusted may run with open egress)', async () => {
    const calls: Call[] = []
    mockDefault(calls, 'absent')
    fetchEveSpec.mockResolvedValue({ ...SPEC, networkAccess: 'something-new' })
    const mod = await loadSandboxModule()

    await expect(mod.default(selectorCtx as never)).rejects.toThrow(/cannot proceed off Vercel/)
    expect(calls.some((c) => c.kind === 'run')).toBe(false)
  })

  it('isolated run with a policy-capable provider: the setter gets github.com + the push gate ONLY', async () => {
    const calls: Call[] = []
    mockDefault(calls, 'ok')
    fetchEveSpec.mockResolvedValue({ ...SPEC, networkAccess: 'isolated' })
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    const set = calls.find((c) => c.kind === 'setNetworkPolicy')!.arg as { allow: Record<string, unknown> }
    expect(Object.keys(set.allow).sort()).toEqual([PUSH_HOST, 'github.com'])
  })

  it('a failed clone throws off Vercel too (the unbrokered path)', async () => {
    const calls: Call[] = []
    mockDefault(calls, 'absent', { fail: { match: /^git clone/, exitCode: 128, stderr: 'fatal: repository not found' } })
    fetchEveSpec.mockResolvedValue({ ...SPEC, networkAccess: 'trusted' })
    const mod = await loadSandboxModule()

    await expect(mod.default(selectorCtx as never)).rejects.toThrow(/git clone of acme\/app@main failed \(exit 128\)/)
    expect(runCommands(calls)).toHaveLength(1)
  })

  it('a trusted run (already allow-all) proceeds off Vercel without a policy-capable provider, with a beat', async () => {
    const calls: Call[] = []
    mockDefault(calls, 'absent')
    fetchEveSpec.mockResolvedValue({ ...SPEC, networkAccess: 'trusted' })
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    expect(beats().some((b) => b.includes('no network-policy support'))).toBe(true)
    expect(calls.some((c) => c.kind === 'run')).toBe(true)
  })

  it('that beat says what to set outside eve dev, and says "dev only" only under eve dev', async () => {
    for (const dev of [false, true]) {
      vi.resetModules()
      postEvent.mockClear()
      vi.stubEnv('EVE_DEV', dev ? '1' : '')
      const calls: Call[] = []
      mockDefault(calls, 'absent')
      fetchEveSpec.mockResolvedValue({ ...SPEC, networkAccess: 'trusted' })
      const mod = await loadSandboxModule()

      await mod.default(selectorCtx as never)

      const beat = beats().find((b) => b.includes('egress is unrestricted'))!
      expect(beat).toBeDefined()
      if (dev) {
        expect(beat).toContain('(dev only)')
      } else {
        expect(beat).not.toContain('dev only')
        for (const name of mod.SANDBOX_CREDENTIAL_ENVS) expect(beat).toContain(name)
      }
    }
  })

  it('a narrowed run\'s refusal names the settings that would let it run', async () => {
    const calls: Call[] = []
    mockDefault(calls, 'absent')
    fetchEveSpec.mockResolvedValue(SPEC)
    const mod = await loadSandboxModule()

    const err = await Promise.resolve(mod.default(selectorCtx as never)).then(() => null, (e: unknown) => e as Error)
    expect(err!.message).toMatch(/restricted run cannot proceed off Vercel/)
    expect(err!.message).toContain('SANDBOX_ACCESS_TOKEN')
  })
})

describe('coding-agent sandbox selector — off Vercel WITH the hosted sandbox\'s settings (the app\'s own server)', () => {
  const ACCESS = 'madeup_access_token_0123456789'
  const CREDS = { token: ACCESS, teamId: 'team_madeup0001', projectId: 'prj_madeup0001' }

  beforeEach(() => {
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('EVE_DEV', '')
    vi.stubEnv('EVE_EVALUATION', '')
    vi.stubEnv('SANDBOX_ACCESS_TOKEN', ` ${ACCESS}\n`) // trimmed, as the cloud browser trims
    vi.stubEnv('SANDBOX_TEAM_ID', CREDS.teamId)
    vi.stubEnv('SANDBOX_PROJECT_ID', CREDS.projectId)
    // eve's local provider must never be built here: this mode is the hosted one.
    vi.doMock('eve/sandbox', async (importOriginal) => {
      const actual = await importOriginal<typeof import('eve/sandbox')>()
      return {
        ...actual,
        DefaultSandbox: {
          name: 'default',
          environment: () => {
            throw new Error('DefaultSandbox must not be constructed when the hosted sandbox is configured')
          },
        },
      }
    })
  })

  function mockHosted(calls: Call[], fake?: FakeOpts) {
    const envOptions: unknown[] = []
    const env = {
      provider: 'vercel',
      open: vi.fn(async (o: unknown) => {
        calls.push({ kind: 'open', arg: o })
        return fakeSandbox(calls, fake)
      }),
    }
    vi.doMock('eve/sandbox/vercel', () => ({
      VercelSandbox: {
        environment: (o: unknown) => {
          envOptions.push(o)
          return env
        },
      },
    }))
    return { env, envOptions }
  }

  const leaksAccess = (text: string) => text.includes(ACCESS)

  it('exports a dedicated Vercel environment with the deny-all baseline AND the three credentials (on the environment, as eve expects)', async () => {
    const { env, envOptions } = mockHosted([])
    const mod = await loadSandboxModule()
    expect(mod.environment).toBe(env)
    expect(envOptions).toEqual([{ networkPolicy: 'deny-all', ...CREDS }])
  })

  it('every run tier OPENS with its policy and the brokered GitHub + push credentials, exactly as on Vercel; no setter, no credential in any command', async () => {
    for (const networkAccess of ['restricted', 'isolated', 'trusted', 'something-new'] as const) {
      vi.resetModules()
      postEvent.mockClear()
      const calls: Call[] = []
      mockHosted(calls)
      fetchEveSpec.mockResolvedValue({ ...SPEC, networkAccess })
      const mod = await loadSandboxModule()

      await mod.default(selectorCtx as never)

      expect(calls[0]).toEqual({
        kind: 'open',
        arg: {
          networkPolicy: mod.buildNetworkPolicy(networkAccess as never, {
            repoFullName: 'acme/app',
            pushUrl: PUSH_URL,
            broker: { githubToken: TOKEN, pushToken: 'push.tokenexample' },
          }),
        },
      })
      const opened = calls[0].arg as { networkPolicy: { allow: Record<string, unknown> } }
      expect(opened.networkPolicy.allow['github.com']).toEqual(mod.githubReadRules(TOKEN, 'acme/app'))
      if (networkAccess !== 'trusted') expect(Object.keys(opened.networkPolicy.allow)).not.toContain('*')
      expect(calls.some((c) => c.kind === 'setNetworkPolicy')).toBe(false)
      // The brokered path: no GitHub or push credential, no extraheader, in any command or env.
      const commands = runCommands(calls)
      expect(commands[0]).toContain(`'https://github.com/acme/app.git'`)
      expect(commands.some(leaksToken) || runEnvs(calls).some(leaksToken)).toBe(false)
      expect(commands.some(leaksPushToken) || runEnvs(calls).some(leaksPushToken)).toBe(false)
      expect(commands.some((c) => c.includes('extraheader'))).toBe(false)
      expect(beats().some((b) => b.startsWith('Sandbox ready'))).toBe(true)
      // The access token logs the app in to the service: it is in no policy,
      // command, env, file or beat.
      expect(calls.some((c) => leaksAccess(JSON.stringify(c)))).toBe(false)
      expect(beats().some(leaksAccess)).toBe(false)
    }
  })

  it('no spec: opens deny-all on the hosted sandbox and runs nothing', async () => {
    const calls: Call[] = []
    mockHosted(calls)
    fetchEveSpec.mockResolvedValue(null)
    const mod = await loadSandboxModule()

    await mod.default(selectorCtx as never)

    expect(calls).toEqual([{ kind: 'open', arg: { networkPolicy: 'deny-all' } }])
  })

  it('a partial set of the three refuses to load (at eve build and at agent start), naming what is missing and never a value', async () => {
    vi.stubEnv('SANDBOX_PROJECT_ID', '  ')
    mockHosted([])
    const err = await loadSandboxModule().then(() => null, (e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/SANDBOX_PROJECT_ID not set \(all three of SANDBOX_ACCESS_TOKEN, SANDBOX_TEAM_ID, SANDBOX_PROJECT_ID, or none\)/)
    expect(leaksAccess(err!.message)).toBe(false)
  })

  it('on Vercel the three settings are ignored: the deployment\'s own credentials, as before', async () => {
    vi.stubEnv('VERCEL', '1')
    const { envOptions } = mockHosted([])
    await loadSandboxModule()
    expect(envOptions).toEqual([{ networkPolicy: 'deny-all' }])
  })
})

describe('hostedSandboxCredentials', () => {
  it('all three → the trimmed set; none (or blank) → null; some → throws', async () => {
    vi.stubEnv('VERCEL', '1')
    mockVercelNoop()
    const mod = await loadSandboxModule()
    expect(mod.hostedSandboxCredentials({ SANDBOX_ACCESS_TOKEN: ' t ', SANDBOX_TEAM_ID: 'team_x', SANDBOX_PROJECT_ID: 'prj_x' })).toEqual({
      token: 't',
      teamId: 'team_x',
      projectId: 'prj_x',
    })
    expect(mod.hostedSandboxCredentials({})).toBeNull()
    expect(mod.hostedSandboxCredentials({ SANDBOX_ACCESS_TOKEN: ' ', SANDBOX_TEAM_ID: '', SANDBOX_PROJECT_ID: '\n' })).toBeNull()
    expect(() => mod.hostedSandboxCredentials({ SANDBOX_ACCESS_TOKEN: 't' })).toThrow(/SANDBOX_TEAM_ID, SANDBOX_PROJECT_ID not set/)
  })
})

describe('sessionNetworkPolicy', () => {
  it('fails closed to deny-all without a spec', async () => {
    vi.stubEnv('VERCEL', '1')
    mockVercelNoop()
    const mod = await loadSandboxModule()
    expect(mod.sessionNetworkPolicy(null)).toBe('deny-all')
  })
})

describe('requireDefinedNetworkPolicy (the guard every open goes through)', () => {
  it('refuses an absent policy and passes any defined one through unchanged', async () => {
    vi.stubEnv('VERCEL', '1')
    mockVercelNoop()
    const mod = await loadSandboxModule()
    expect(() => mod.requireDefinedNetworkPolicy(undefined)).toThrow(/refusing to open/)
    expect(() => mod.requireDefinedNetworkPolicy(null)).toThrow(/refusing to open/)
    expect(mod.requireDefinedNetworkPolicy('deny-all')).toBe('deny-all')
    const p = mod.buildNetworkPolicy('restricted', { repoFullName: 'acme/app', pushUrl: PUSH_URL, broker: null })
    expect(mod.requireDefinedNetworkPolicy(p)).toBe(p)
  })

  it('openSessionSandbox routes EVERY open through it (source pin: a behavioural test cannot swap the module-internal builder)', () => {
    const source = readFileSync(fileURLToPath(new URL('../../sandbox.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('async function openSessionSandbox(')
    expect(start).toBeGreaterThan(-1)
    const bodyStart = source.indexOf('{\n', source.indexOf('): Promise<', start))
    const body = source.slice(bodyStart, source.indexOf('\n}\n', bodyStart))
    // The one policy both opens use comes out of the guard...
    expect(body).toMatch(/const policy = requireDefinedNetworkPolicy\(sessionNetworkPolicy\(spec\)\)/)
    // ...the Vercel open passes exactly that...
    expect(body).toMatch(/vercelEnvironment\.open\(\{ networkPolicy: policy \}\)/)
    // ...the local path applies exactly that...
    expect(body).toMatch(/applyLocalPolicy\(sandbox, policy\)/)
    // ...and nothing else opens or builds a policy in this function.
    expect(body.match(/\.open\(/g)).toHaveLength(2)
    expect(body.match(/NetworkPolicy\(/g)).toHaveLength(2) // requireDefined… + session…
    // The selector opens only through openSessionSandbox.
    const selector = source.slice(source.indexOf('export default defineSandbox('))
    expect(selector).not.toMatch(/Environment!?\.open\(/)
    expect(selector).toMatch(/await openSessionSandbox\(spec, runToken\)/)
  })
})

function mockVercelNoop() {
  vi.doMock('eve/sandbox/vercel', () => ({
    VercelSandbox: { environment: () => ({ provider: 'vercel', open: vi.fn() }) },
  }))
}

describe('envHookCommand — a `bash -lc` shell (eve runs commands this way) sees the user env', () => {
  // Real bash in a throwaway HOME: the only honest way to pin shell startup semantics.
  async function runHook(seed: Record<string, string>) {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { spawnSync } = await import('node:child_process')
    const home = mkdtempSync(join(tmpdir(), 'ni-env-hook-'))
    writeFileSync(join(home, '.dial8_env'), `export FOO='from env file'\n`)
    for (const [name, content] of Object.entries(seed)) writeFileSync(join(home, name), content)
    const mod = await loadSandboxModule()
    const env = { HOME: home, PATH: '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv
    const hook = spawnSync('bash', ['-c', mod.envHookCommand('.dial8_env')], { env, encoding: 'utf8' })
    expect(hook.status).toBe(0)
    const login = spawnSync('bash', ['-lc', 'printf %s "$FOO"'], { env, encoding: 'utf8' })
    return { home, foo: login.stdout, readFile: (n: string) => readFileSync(join(home, n), 'utf8') }
  }

  it('with only a Debian-style ~/.bashrc (interactive guard) the login shell still gets FOO', async () => {
    const r = await runHook({ '.bashrc': '[ -z "$PS1" ] && return\n' })
    expect(r.foo).toBe('from env file')
  })

  it('with an existing ~/.bash_profile (which shadows ~/.profile) the login shell still gets FOO', async () => {
    const r = await runHook({ '.bash_profile': 'export BASE=1\n' })
    expect(r.foo).toBe('from env file')
    expect(r.readFile('.bash_profile')).toContain('export BASE=1\n')
  })
})
