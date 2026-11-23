import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'

const ASSET = '22222222-2222-4222-8222-222222222222'
const IMP = '33333333-3333-4333-8333-333333333333'
const DOC = '44444444-4444-4444-8444-444444444444'

let svcTables: Record<string, Record<string, unknown>[]>
let callerDocs: Record<string, unknown>[]
const signed = vi.fn(async (path: string) => ({ data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null }))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => ({ supabase: memoryDb({ document: callerDocs }), workspaceId: 'ws-1', user: { id: 'viewer' } }),
}))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => Object.assign(memoryDb(svcTables), { storage: { from: () => ({ createSignedUrl: signed }) } }),
}))

import { GET } from '../assets/[id]/route'

const call = () => GET(new Request('http://x'), { params: Promise.resolve({ id: ASSET }) })

beforeEach(() => {
  signed.mockClear()
  svcTables = {
    work_import: [{ id: IMP, user_id: 'importer', workspace_id: 'ws-1' }],
    work_import_item: [
      { id: ASSET, import_id: IMP, workspace_id: 'ws-1', kind: 'asset', record: { kind: 'asset', file_name: 'p.png' }, outcome: 'created', undo_outcome: null },
      { id: 'doc-item', import_id: IMP, workspace_id: 'ws-1', kind: 'document', entity_id: DOC, outcome: 'created' },
    ],
  }
  callerDocs = []
})

describe('GET /api/account/imports/assets/[id]', () => {
  it('sends someone who can read a page that shows the file to a short-lived link', async () => {
    callerDocs.push({ id: DOC, content: `![x](/api/account/imports/assets/${ASSET})` })
    const res = await call()
    expect(res.status).toBe(302)
    expect(signed).toHaveBeenCalledWith(`importer/imports/${IMP}/${ASSET}-p.png`, 300)
  })

  it('is not found for someone who can read no page that shows it', async () => {
    // The caller's own client returns nothing: the page is private to someone else.
    expect((await call()).status).toBe(404)
    // A page they can read that does not show the file is no key either.
    callerDocs.push({ id: DOC, content: 'no image here' })
    expect((await call()).status).toBe(404)
    expect(signed).not.toHaveBeenCalled()
  })

  it('is not found once undone, or in another workspace', async () => {
    callerDocs.push({ id: DOC, content: `![x](/api/account/imports/assets/${ASSET})` })
    svcTables.work_import_item[0].undo_outcome = 'removed'
    expect((await call()).status).toBe(404)
    svcTables.work_import_item[0].undo_outcome = null
    svcTables.work_import_item[0].workspace_id = 'ws-2'
    expect((await call()).status).toBe(404)
  })
})
