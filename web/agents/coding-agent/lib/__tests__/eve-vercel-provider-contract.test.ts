/**
 * CONTRACT tests for eve's REAL Vercel sandbox provider — the code that turns
 * sandbox.ts's `vercelEnvironment.open({ networkPolicy })` into a Vercel
 * `Sandbox.create()` call. sandbox-selector.test.ts mocks `eve/sandbox/vercel`
 * wholesale, so it can only prove what sandbox.ts ASKS for; these tests drive
 * eve 0.66.3's own binding (dist/src/execution/sandbox/bindings/vercel.js) with
 * a fake `@vercel/sandbox` module and pin the three egress facts sandbox.ts's
 * header relies on:
 *
 *   1. A snapshot-backed session is CREATED with the open() network policy —
 *      no allow-all window before a later update. (Without a snapshot eve
 *      creates allow-all and narrows afterwards; test 3 documents that path,
 *      and test 1 pins that the environment sandbox.ts uses always snapshots.)
 *   2. `resume()` of a sandbox that no longer exists THROWS instead of creating
 *      an unpoliced replacement (risk #13).
 *   3. An explicit `networkPolicy: undefined` in open() overrides the
 *      environment's `deny-all` baseline — why sandbox.ts refuses to open
 *      without a defined policy.
 *
 * What this cannot prove: that Vercel's service enforces the policy it is
 * handed. That needs a live preview run (see the WS-0 report's
 * needs_live_verification). An eve bump that changes any of this fails here.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))
const bindingPath = join(eveRoot, 'dist/src/execution/sandbox/bindings/vercel.js')
const publicProviderPath = join(eveRoot, 'dist/src/sandbox/providers/vercel.js')

type Policy = unknown
type ProviderImpl = {
  prepare(input: { resources: Record<string, unknown>; sourceRevision?: string; log?: (m: string) => void }): Promise<{ snapshotId?: string }>
  start(ctx: { session: { id: string } }, options: Record<string, unknown> | undefined, artifact: { snapshotId?: string }): Promise<{ handle: unknown; state: { sandboxName: string } }>
  resume(ctx: { session: { id: string } }, artifact: { snapshotId?: string }, state: { sandboxName: string; version: 3 }): Promise<unknown>
}
type CreateVercelSandbox = (input: {
  createOptions?: Record<string, unknown>
  loadSandboxModule?: () => Promise<unknown>
  loadDeleteSandboxModule?: () => Promise<unknown>
  prepare?: unknown
  skipEmptyPreparation?: boolean
}) => ProviderImpl

async function loadBinding(): Promise<{ createVercelSandbox: CreateVercelSandbox }> {
  return (await import(pathToFileURL(bindingPath).href)) as { createVercelSandbox: CreateVercelSandbox }
}

const RESTRICTED: Policy = {
  allow: { 'github.com': [{ transform: [{ headers: { authorization: 'Basic x' } }] }], 'registry.npmjs.org': [] },
}

/** A fake `@vercel/sandbox` module recording every create + update. */
function fakeVercelModule() {
  const sandboxes = new Map<string, ReturnType<typeof makeSandbox>>()
  const creates: Array<Record<string, unknown>> = []
  const updates: Array<{ name: string; update: Record<string, unknown> }> = []

  function makeSandbox(name: string) {
    return {
      name,
      status: 'running',
      tags: undefined as Record<string, string> | undefined,
      currentSnapshotId: undefined as string | undefined,
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: async () => '', stderr: async () => '' })),
      update: vi.fn(async (u: Record<string, unknown>) => {
        updates.push({ name, update: u })
      }),
      writeFiles: vi.fn(async () => {}),
      snapshot: vi.fn(async () => ({ snapshotId: `snap_${name}` })),
      stop: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    }
  }

  const Sandbox = {
    get: vi.fn(async ({ name }: { name: string }) => {
      const found = sandboxes.get(name)
      if (found) return found
      throw Object.assign(new Error(`sandbox ${name} not found`), { status: 404 })
    }),
    create: vi.fn(async (params: Record<string, unknown>) => {
      creates.push(params)
      const sb = makeSandbox(String(params.name))
      sandboxes.set(sb.name, sb)
      return sb
    }),
  }
  return { module: { Sandbox }, creates, updates, sandboxes }
}

function providerFor(fake: ReturnType<typeof fakeVercelModule>, createVercelSandbox: CreateVercelSandbox) {
  // Mirrors eve's createVercelSandboxProvider(options) → createVercelSandbox({
  // createOptions, prepare }) — the path `VercelSandbox.environment()` takes —
  // with only the SDK loaders swapped for the fake.
  return createVercelSandbox({
    createOptions: { networkPolicy: 'deny-all' },
    loadSandboxModule: async () => fake.module,
    loadDeleteSandboxModule: async () => fake.module,
  })
}

const ctx = { session: { id: 'wrun_CONTRACT' } }

beforeEach(() => {
  // Resolve Vercel credentials from env so the binding never reaches for an
  // OIDC refresh (a network call) during lookups.
  vi.stubEnv('VERCEL_TOKEN', 'test-token')
  vi.stubEnv('VERCEL_TEAM_ID', 'team_test')
  vi.stubEnv('VERCEL_PROJECT_ID', 'prj_test')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('eve 0.66.3 Vercel sandbox provider — egress contract', () => {
  it('the public VercelSandbox.environment() routes through createVercelSandboxProvider, which never skips snapshot preparation', () => {
    // Tripwire on eve's own source: if a bump routes VercelSandbox.environment()
    // through the skipEmptyPreparation default provider, sessions can start
    // without a snapshot and take the allow-all-then-narrow path (test 3).
    const src = readFileSync(publicProviderPath, 'utf8')
    expect(src).toMatch(/provider=defineSandboxProvider\(\{name:`vercel`,environment:e=>createVercelSandboxProvider\(e\)\}\)/)
    expect(src).toMatch(/const VercelSandbox=\{name:`vercel`,environment\(e\)\{return provider\.environment\(e\)\}\}/)
    const binding = readFileSync(bindingPath, 'utf8')
    expect(binding).toMatch(/function createVercelSandboxProvider\(e\)\{let\{prepare:t,\.\.\.n\}=e\?\?\{\};return createVercelSandbox\(\{createOptions:n,prepare:t\}\)\}/)
  })

  it('prepare() always yields a snapshot for that environment, even with no resources and no prepare hook', async () => {
    const { createVercelSandbox } = await loadBinding()
    const fake = fakeVercelModule()
    const artifact = await providerFor(fake, createVercelSandbox).prepare({ resources: {}, sourceRevision: 'rev-1' })
    expect(typeof artifact.snapshotId).toBe('string')
    expect(artifact.snapshotId!.length).toBeGreaterThan(0)
  })

  it('snapshot-backed start(): Sandbox.create carries the open() networkPolicy itself — no allow-all create, no later narrowing', async () => {
    const { createVercelSandbox } = await loadBinding()
    const fake = fakeVercelModule()
    const provider = providerFor(fake, createVercelSandbox)

    await provider.start(ctx, { networkPolicy: RESTRICTED }, { snapshotId: 'snap_tpl' })

    expect(fake.creates).toHaveLength(1)
    expect(fake.creates[0].networkPolicy).toEqual(RESTRICTED)
    expect(fake.creates[0].source).toEqual({ snapshotId: 'snap_tpl', type: 'snapshot' })
    expect(fake.updates.filter((u) => 'networkPolicy' in u.update)).toEqual([])
  })

  it('WITHOUT a snapshot eve creates allow-all and narrows afterwards — the window the always-snapshot environment avoids', async () => {
    const { createVercelSandbox } = await loadBinding()
    const fake = fakeVercelModule()
    await providerFor(fake, createVercelSandbox).start(ctx, { networkPolicy: RESTRICTED }, {})

    expect(fake.creates[0].networkPolicy).toBe('allow-all')
    expect(fake.updates.filter((u) => 'networkPolicy' in u.update).map((u) => u.update.networkPolicy)).toEqual([RESTRICTED])
  })

  it('an explicit networkPolicy: undefined in open() OVERRIDES the environment deny-all baseline (why sandbox.ts refuses to open without one)', async () => {
    const { createVercelSandbox } = await loadBinding()
    const fake = fakeVercelModule()
    await providerFor(fake, createVercelSandbox).start(ctx, { networkPolicy: undefined }, { snapshotId: 'snap_tpl' })
    expect(fake.creates[0].networkPolicy).toBeUndefined()

    const fake2 = fakeVercelModule()
    await providerFor(fake2, createVercelSandbox).start(ctx, undefined, { snapshotId: 'snap_tpl' })
    // With the key ABSENT the baseline applies.
    expect(fake2.creates[0].networkPolicy).toBe('deny-all')
  })

  it('resume() of a sandbox that no longer exists THROWS and never creates an unpoliced replacement (risk #13)', async () => {
    const { createVercelSandbox } = await loadBinding()
    const fake = fakeVercelModule()
    const provider = providerFor(fake, createVercelSandbox)
    const { state } = await provider.start(ctx, { networkPolicy: RESTRICTED }, { snapshotId: 'snap_tpl' })
    expect(fake.creates).toHaveLength(1)

    fake.sandboxes.delete(state.sandboxName) // provider-side loss mid-run
    await expect(
      provider.resume(ctx, { snapshotId: 'snap_tpl' }, { sandboxName: state.sandboxName, version: 3 }),
    ).rejects.toThrow(/no longer exists/)
    expect(fake.creates).toHaveLength(1)
  })

  it('a re-start() of the same session + policy reuses the same named sandbox rather than creating a second one', async () => {
    const { createVercelSandbox } = await loadBinding()
    const fake = fakeVercelModule()
    const provider = providerFor(fake, createVercelSandbox)
    const a = await provider.start(ctx, { networkPolicy: RESTRICTED }, { snapshotId: 'snap_tpl' })
    const b = await provider.start(ctx, { networkPolicy: RESTRICTED }, { snapshotId: 'snap_tpl' })
    expect(b.state.sandboxName).toBe(a.state.sandboxName)
    expect(fake.creates).toHaveLength(1)
    // A DIFFERENT policy names a different sandbox — a same-name sandbox was
    // always created with this exact policy.
    const c = await provider.start(ctx, { networkPolicy: 'deny-all' }, { snapshotId: 'snap_tpl' })
    expect(c.state.sandboxName).not.toBe(a.state.sandboxName)
  })
})
