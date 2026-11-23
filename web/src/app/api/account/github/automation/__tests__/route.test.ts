/** The workspace's repositories for pull-request automation (migration 694): owners and admins choose them, lower case. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'

const h = vi.hoisted(() => ({ auth: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: async () => h.auth }))

import { DELETE, GET, POST } from '../route'

let tables: Record<string, Array<Record<string, unknown>>>
const as = (role: string) => {
  h.auth = { supabase: memoryDb(tables), user: { id: 'u1' }, workspaceId: 'ws-1', member: { id: 'm1', role } }
}
const post = (repo: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ repo }) })

beforeEach(() => {
  tables = { workspace_github_repo: [{ workspace_id: 'ws-1', repo_full_name: 'acme/app' }, { workspace_id: 'ws-2', repo_full_name: 'acme/other' }] }
  as('owner')
})

describe('/api/account/github/automation', () => {
  it('lists this workspace’s repos, and says who may change them', async () => {
    as('member')
    const body = await (await GET()).json()
    expect(body).toEqual({ repos: [expect.objectContaining({ repo_full_name: 'acme/app' })], canManage: false })
  })

  it('adds one lower case, from a name or a GitHub link, as the caller', async () => {
    expect((await POST(post('https://github.com/Acme/Web.git'))).status).toBe(201)
    expect(tables.workspace_github_repo).toContainEqual(expect.objectContaining({ workspace_id: 'ws-1', repo_full_name: 'acme/web', added_by: 'u1' }))
    expect((await POST(post('not a repo'))).status).toBe(400)
  })

  it('refuses a member or a guest', async () => {
    for (const role of ['member', 'guest']) {
      as(role)
      expect((await POST(post('acme/web'))).status).toBe(403)
      expect((await DELETE(new Request('http://localhost/x?repo=acme/app', { method: 'DELETE' }))).status).toBe(403)
    }
    expect(tables.workspace_github_repo).toHaveLength(2)
  })

  it('removes one of this workspace’s only', async () => {
    await DELETE(new Request('http://localhost/x?repo=Acme/App', { method: 'DELETE' }))
    await DELETE(new Request('http://localhost/x?repo=acme/other', { method: 'DELETE' }))
    expect(tables.workspace_github_repo).toEqual([{ workspace_id: 'ws-2', repo_full_name: 'acme/other' }])
  })
})
