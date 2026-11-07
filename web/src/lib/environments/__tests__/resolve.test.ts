/**
 * resolveRunEnvironment: a run that recorded its environment runs there or
 * nowhere (archived, gone, another workspace's, a Mac or someone else's "only
 * me" fails it with RUN_ENVIRONMENT_UNUSABLE, never a fall-through to a more
 * open one). A run that recorded none gets its project's, else the workspace
 * default (each shared and live), else none. A read error throws;
 * runEnvironmentIdFor stamps null instead, and reads no secrets.
 */
import { describe, expect, it, vi } from 'vitest'
import { fakeDb, type Row } from '@/lib/local-agent/__tests__/fake-db'
import { RUN_ENVIRONMENT_UNUSABLE_REASON, resolveRunEnvironment, runEnvironmentIdFor, runEnvironmentUsable } from '../resolve'
import { RUN_ENVIRONMENT_UNUSABLE_CODE } from '../types'

const WS = 'ws-1'
const STARTER = 'user-1'

function env(id: string, over: Row = {}): Row {
  return {
    id, kind: 'cloud', name: id, workspace_id: WS, shared: true, created_by: null,
    network_access: 'restricted', env_vars: `${id.toUpperCase()}=1`, setup_script: `setup ${id}`, archived_at: null, ...over,
  }
}

function world(envs: Row[], opts: { projectEnv?: string | null; workspaceDefault?: string | null } = {}) {
  return fakeDb({
    environment: envs,
    projects: [{ id: 'p1', workspace_id: WS, environment_id: opts.projectEnv ?? null }],
    workspace: [{ id: WS, default_cloud_environment_id: opts.workspaceDefault ?? null }],
  }) as never
}

describe('resolveRunEnvironment', () => {
  it('the run’s own, then the project’s, then the workspace default', async () => {
    const svc = world([env('run'), env('proj'), env('ws')], { projectEnv: 'proj', workspaceDefault: 'ws' })
    expect(await resolveRunEnvironment(svc, { runEnvironmentId: 'run', projectId: 'p1', workspaceId: WS })).toEqual({
      environmentId: 'run', name: 'run', source: 'run', networkAccess: 'restricted', envVars: 'RUN=1', setupScript: 'setup run',
    })
    expect((await resolveRunEnvironment(svc, { projectId: 'p1', workspaceId: WS }))?.source).toBe('project')
    expect((await resolveRunEnvironment(svc, { workspaceId: WS }))?.environmentId).toBe('ws')
    expect(await resolveRunEnvironment(world([]), { projectId: 'p1', workspaceId: WS })).toBeNull()
  })

  it('a run whose own environment can’t be used fails, and never falls through to the project’s or the default', async () => {
    for (const [label, envs] of [
      ['archived', [env('run', { archived_at: '2026-10-22T00:00:00Z' })]],
      ['gone', []],
      ['another workspace’s', [env('run', { workspace_id: 'ws-2' })]],
      ['a Mac', [env('run', { kind: 'mac', workspace_id: null, network_access: null })]],
      ['someone else’s "only me"', [env('run', { shared: false, created_by: 'someone-else' })]],
      ['an unknown network', [env('run', { network_access: 'open' })]],
    ] as Array<[string, Row[]]>) {
      // A trusted default with its own vars sits right there: it must never be used instead.
      const svc = world([...envs, env('proj'), env('ws', { network_access: 'trusted' })], { projectEnv: 'proj', workspaceDefault: 'ws' })
      await expect(resolveRunEnvironment(svc, { runEnvironmentId: 'run', projectId: 'p1', workspaceId: WS, userId: STARTER }), label).rejects.toMatchObject({
        code: 'conflict', message: RUN_ENVIRONMENT_UNUSABLE_REASON, details: { code: RUN_ENVIRONMENT_UNUSABLE_CODE },
      })
    }
  })

  it('with no environment of its own: an archived, unshared or foreign project environment is skipped, to the default', async () => {
    for (const bad of [
      env('proj', { archived_at: '2026-10-22T00:00:00Z' }),
      env('proj', { shared: false, created_by: STARTER }),
      env('proj', { workspace_id: 'ws-2' }),
    ]) {
      const svc = world([bad, env('ws')], { projectEnv: 'proj', workspaceDefault: 'ws' })
      expect((await resolveRunEnvironment(svc, { projectId: 'p1', workspaceId: WS, userId: STARTER }))?.environmentId).toBe('ws')
    }
  })

  it('the run’s own may be its starter’s "only me" one; a project’s or the default never may', async () => {
    const mine = env('mine', { shared: false, created_by: STARTER })
    expect((await resolveRunEnvironment(world([mine]), { runEnvironmentId: 'mine', workspaceId: WS, userId: STARTER }))?.source).toBe('run')
    await expect(resolveRunEnvironment(world([mine]), { runEnvironmentId: 'mine', workspaceId: WS })).rejects.toMatchObject({ code: 'conflict' })
    expect(await resolveRunEnvironment(world([mine], { projectEnv: 'mine', workspaceDefault: 'mine' }), { projectId: 'p1', workspaceId: WS, userId: STARTER })).toBeNull()
    expect(await runEnvironmentUsable(world([mine]), { environmentId: 'mine', workspaceId: WS, userId: STARTER })).toBe(true)
    expect(await runEnvironmentUsable(world([mine]), { environmentId: 'mine', workspaceId: WS, userId: 'someone-else' })).toBe(false)
  })

  it('stamping a new run reads no secrets', async () => {
    const db = fakeDb({ environment: [env('proj')], projects: [{ id: 'p1', workspace_id: WS, environment_id: 'proj' }], workspace: [] })
    const selects: string[] = []
    const from = db.from
    db.from = (t: string) => {
      const c = from(t) as Record<string, (...a: unknown[]) => unknown>
      const select = c.select
      if (t === 'environment') c.select = (p?: unknown) => (selects.push(String(p)), select(p))
      return c
    }
    expect(await runEnvironmentIdFor(db as never, { projectId: 'p1', workspaceId: WS })).toBe('proj')
    expect(selects).toHaveLength(1)
    expect(selects[0]).not.toMatch(/env_vars|setup_script/)
  })

  it('a project of another workspace lends nothing', async () => {
    const svc = world([env('proj')], { projectEnv: 'proj' })
    expect(await resolveRunEnvironment(svc, { projectId: 'p1', workspaceId: 'ws-2' })).toBeNull()
  })

  it('a read error throws; runEnvironmentIdFor stamps null instead', async () => {
    const broken = {
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }), maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) }),
    } as never
    await expect(resolveRunEnvironment(broken, { workspaceId: WS })).rejects.toThrow(/down/)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await runEnvironmentIdFor(broken, { workspaceId: WS })).toBeNull()
    warn.mockRestore()
    expect(await runEnvironmentIdFor(world([env('proj')], { projectEnv: 'proj' }), { projectId: 'p1', workspaceId: WS })).toBe('proj')
  })
})
