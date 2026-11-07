/**
 * The offline fallback (docs/plans/environments.md §3, "Offline Mac"): an
 * offline Mac's folder gets a cloud coding run offered instead of the 6-hour
 * wait only when its LINKED repo (device_folder_setting.repo_full_name, never
 * a guess from its name) is a project's repo in the chat's workspace, and it
 * runs in that project's shared cloud environment, which the offer names with
 * its network level.
 */
import { describe, expect, it, vi } from 'vitest'
import { cloudFallbackFor } from '../cloud-fallback'
import { FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

const input = { userId: USER, workspaceId: WS, folderId: FOLDER }
const github = { user_id: USER, provider: 'github', capability: 'github', access_token: 'gho', id: 't1' }
const OTHER_WS = '00000000-0000-4000-8000-000000000000'
const ENV = '99999999-9999-4999-8999-999999999901'
const ENV2 = '99999999-9999-4999-8999-999999999902'
const DEFAULT_ENV = '99999999-9999-4999-8999-999999999903'
const ONLY_ME = '99999999-9999-4999-8999-999999999904'

const project = (id: string, repo: string | null, extra: Record<string, unknown> = {}) => ({ id, name: 'Website', github_repo: repo, workspace_id: WS, environment_id: ENV, ...extra })
const cloud = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'cloud', name: 'Staging', workspace_id: WS, shared: true, network_access: 'restricted', created_by: USER, archived_at: null, ...extra,
})

function db(opts: { projects: Array<Record<string, unknown>>; linked?: string | null; extra?: Record<string, unknown[]> }): FakeDb {
  return seeded({
    projects: opts.projects,
    user_oauth_tokens: [github],
    environment: [cloud(ENV), cloud(ENV2, { name: 'Other' }), cloud(DEFAULT_ENV, { name: 'Default cloud', network_access: 'trusted' }), cloud(ONLY_ME, { shared: false })],
    workspace: [{ id: WS, default_cloud_environment_id: DEFAULT_ENV }],
    device_folder_setting: opts.linked === null ? [] : [{ device_folder_id: FOLDER, base_branch: null, repo_full_name: opts.linked ?? 'liamadsr/dial8-website' }],
    ...(opts.extra ?? {}),
  } as never)
}

describe('cloudFallbackFor', () => {
  it('matches the folder’s linked repo to a project here, and names that project’s environment and its network', async () => {
    const d = db({ projects: [project('p1', 'liamadsr/dial8-website'), project('p2', 'liamadsr/dial8-desktop', { name: 'Desktop' })] })
    expect(await cloudFallbackFor(d as never, input)).toEqual({
      repo: 'liamadsr/dial8-website',
      projectId: 'p1',
      project: 'Website',
      environmentId: ENV,
      environment: 'Staging',
      networkAccess: 'restricted',
    })
  })

  it('a project with no environment of its own runs where its runs run: the workspace default', async () => {
    const d = db({ projects: [project('p1', 'LiamAdsr/Dial8-Website', { environment_id: null })] })
    expect(await cloudFallbackFor(d as never, input)).toMatchObject({ environmentId: DEFAULT_ENV, environment: 'Default cloud', networkAccess: 'trusted' })
  })

  it('never guesses from the folder’s name: no linked repo, no offer', async () => {
    // The folder is labelled dial8-website, and a project has that repo.
    const d = db({ projects: [project('p1', 'liamadsr/dial8-website')], linked: null })
    expect(await cloudFallbackFor(d as never, input)).toBeNull()
  })

  it('offers nothing for a folder that isn’t git or is removed, a repo no project here has, another workspace’s project, no environment, an “only me” one, or no GitHub sign-in', async () => {
    const notGit = db({ projects: [project('p1', 'liamadsr/dial8-website')] })
    notGit.tables.device_folder[0].is_git = false
    const removed = db({ projects: [project('p1', 'liamadsr/dial8-website')] })
    removed.tables.device_folder[0].revoked_at = new Date().toISOString()
    const noEnvironment = db({ projects: [project('p1', 'liamadsr/dial8-website', { environment_id: null })] })
    noEnvironment.tables.workspace[0].default_cloud_environment_id = null
    const onlyMeNoDefault = db({ projects: [project('p1', 'liamadsr/dial8-website', { environment_id: ONLY_ME })] })
    onlyMeNoDefault.tables.workspace[0].default_cloud_environment_id = null
    const cases: FakeDb[] = [
      notGit,
      removed,
      db({ projects: [project('p1', 'liamadsr/other')] }),
      db({ projects: [project('p1', 'liamadsr/dial8-website', { workspace_id: OTHER_WS })] }),
      noEnvironment,
      onlyMeNoDefault,
      db({ projects: [project('p1', 'liamadsr/dial8-website')], extra: { user_oauth_tokens: [] } }),
      db({ projects: [project('p1', null)] }),
    ]
    for (const [i, d] of cases.entries()) expect(await cloudFallbackFor(d as never, input), String(i)).toBeNull()
  })

  it('two projects on the repo are one offer when they run in one environment, none when they don’t', async () => {
    const same = db({ projects: [project('p1', 'liamadsr/dial8-website'), project('p2', 'LiamAdsr/Dial8-Website', { name: 'Site v2' })] })
    expect((await cloudFallbackFor(same as never, input))?.environmentId).toBe(ENV)
    const split = db({ projects: [project('p1', 'liamadsr/dial8-website'), project('p2', 'liamadsr/dial8-website', { environment_id: ENV2 })] })
    expect(await cloudFallbackFor(split as never, input)).toBeNull()
  })

  it('never throws: a failed lookup offers nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken = { from: () => { throw new Error('boom') } }
    expect(await cloudFallbackFor(broken as never, input)).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
