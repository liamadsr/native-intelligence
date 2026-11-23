/**
 * POST …/revisions/[number]/fork (docs/plans/doc-editor-extras.md, phase 4):
 * a new document with that version's text, in the original's project, team,
 * folder and visibility, created as the person who forks, on their own client.
 * Someone else's private document is a 404; grants are never copied; a folder
 * that refuses the filing leaves the fork made but unfiled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readJson } from '@/test/integration'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'

const env = vi.hoisted(() => ({
  fake: null as null | { client: unknown; log: FakeQuery[] },
  visibility: 'workspace',
  createdBy: 'mem-9',
  folder: 'folder-1' as string | null,
  fileError: null as null | { message: string; code?: string },
  member: true,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ ...(env.fake!.client as object), auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn(async () => ({ chunksCreated: 0 })) }))

const DOC = '11111111-1111-4111-8111-111111111111'
const ROW = (n: number, content: string, title = 'Plan') => ({
  revision_number: n,
  title,
  author_kind: 'human',
  author_id: 'mem-1',
  change_summary: null,
  created_at: 't',
  updated_at: 't',
  author: { display_name: 'Ana' },
  content,
  frontmatter: {},
})

beforeEach(() => {
  env.visibility = 'workspace'
  env.createdBy = 'mem-9'
  env.folder = 'folder-1'
  env.fileError = null
  env.member = true
  env.fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'member') return { data: env.member ? { id: 'mem-1', role: 'member', workspace: { settings: {} } } : null, error: null }
    if (q.table === 'document_revision') {
      const lte = q.filters.find((f) => f[0] === 'lte')?.[2] as number | undefined
      return { data: [ROW(5, 'Now.'), ROW(4, 'Before.', 'Old plan')].filter((r) => lte === undefined || r.revision_number <= lte), error: null }
    }
    if (q.table === 'document' && q.op === 'select') {
      return {
        data: {
          id: DOC, workspace_id: 'ws-1', created_by: env.createdBy, type: 'note', slug: 'plan', published_status: 'published', frontmatter: {},
          project_id: 'proj-1', team_id: 'team-1', status: 'active', title: 'Plan', visibility: env.visibility, tags: ['q4'], canon_key: null,
        },
        error: null,
      }
    }
    if (q.table === 'document' && q.op === 'insert') {
      const p = q.payload as Record<string, unknown>
      return { data: { id: 'new-doc', title: p.title, content: p.content, project_id: p.project_id ?? null, visibility: p.visibility, revision: 1 }, error: null }
    }
    if (q.table === 'drive_folder_item' && q.op === 'select') return { data: env.folder ? { folder_id: env.folder } : null, error: null }
    if (q.table === 'drive_folder_item' && q.op === 'insert') return { data: null, error: env.fileError }
    return { data: null, error: null }
  }) as never
})

const params = (number = '4') => ({ params: Promise.resolve({ id: DOC, number }) })
const post = async (number = '4') => {
  const { POST } = await import('../[number]/fork/route')
  return POST(new NextRequest('https://nativeintelligence.dev/x', { method: 'POST' }), params(number))
}

describe('fork', () => {
  it('copies the version into a new document in the same project, team, folder and visibility', async () => {
    const res = await post('4')
    expect(res.status).toBe(201)
    expect(await readJson(res)).toMatchObject({ document: { id: 'new-doc', title: 'Old plan (version 4)', content: 'Before.' }, forked_from: { id: DOC, revision: 4 }, filed: true })
    const insert = env.fake!.log.find((x) => x.table === 'document' && x.op === 'insert')!
    expect(insert.payload).toMatchObject({
      workspace_id: 'ws-1',
      title: 'Old plan (version 4)',
      content: 'Before.',
      created_by: 'mem-1',
      visibility: 'workspace',
      project_id: 'proj-1',
      team_id: 'team-1',
      tags: ['q4'],
    })
    // Never its slug, canon key or anyone's grants.
    expect(insert.payload).not.toHaveProperty('slug')
    expect(insert.payload).not.toHaveProperty('canon_key')
    expect(env.fake!.log.some((x) => x.table === 'entity_access' && x.op !== 'select')).toBe(false)
    const filed = env.fake!.log.find((x) => x.table === 'drive_folder_item' && x.op === 'insert')!
    expect(filed.payload).toMatchObject({ item_type: 'document', item_id: 'new-doc', folder_id: 'folder-1', workspace_id: 'ws-1', added_by: 'mem-1' })
    // The original is not touched.
    expect(env.fake!.log.some((x) => x.table === 'document' && x.op === 'update')).toBe(false)
  })

  it('a private original that is mine forks private; someone else’s private document is a 404', async () => {
    env.visibility = 'private'
    env.createdBy = 'mem-1'
    expect((await post()).status).toBe(201)
    expect(env.fake!.log.find((x) => x.table === 'document' && x.op === 'insert')!.payload).toMatchObject({ visibility: 'private', created_by: 'mem-1' })

    env.createdBy = 'mem-9'
    env.fake!.log.length = 0
    expect((await post()).status).toBe(404)
    expect(env.fake!.log.some((x) => x.op === 'insert')).toBe(false)
  })

  it('an unfiled original makes an unfiled fork; a refused filing leaves the fork made', async () => {
    env.folder = null
    expect(await readJson(await post())).toMatchObject({ filed: null })
    expect(env.fake!.log.some((x) => x.table === 'drive_folder_item' && x.op === 'insert')).toBe(false)

    env.folder = 'folder-2'
    env.fileError = { message: 'new row violates row-level security policy', code: '42501' }
    const res = await post()
    expect(res.status).toBe(201)
    expect(await readJson(res)).toMatchObject({ document: { id: 'new-doc' }, filed: false })
  })

  it('a version no longer in the history is a 404; a bad number a 400; a non-member a 403', async () => {
    expect((await post('3')).status).toBe(404)
    expect((await post('x')).status).toBe(400)
    env.member = false
    expect((await post()).status).toBe(403)
    expect(env.fake!.log.some((x) => x.op === 'insert')).toBe(false)
  })
})
