import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MAX_PER_KIND, buildMentionedRecordsBlock, gatherMentionedRecords, mentionedIds } from '../mentioned-records'

/**
 * §6h: the actions, docs, projects and initiatives @-mentioned this turn. The
 * ids come from the client and the client reading them is service-role, so
 * every read must be fenced to the workspace (and a private doc to its
 * creator), and only well-formed ids read at all.
 */

type Call = { table: string; method: string; args: unknown[] }

function fakeClient(rows: Record<string, unknown[]>, member: { id: string; role?: string } | null = { id: 'member-1' }) {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'or', 'is']) {
        builder[m] = (...args: unknown[]) => {
          calls.push({ table, method: m, args })
          return builder
        }
      }
      builder.maybeSingle = async () => ({ data: table === 'member' ? member : null, error: null })
      builder.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(ok)
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

const A = '11111111-1111-4111-8111-111111111111'
const D = '22222222-2222-4222-8222-222222222222'
const P = '33333333-3333-4333-8333-333333333333'
const I = '44444444-4444-4444-8444-444444444444'

describe('mentionedIds', () => {
  it('keeps id-shaped strings once, capped', () => {
    expect(mentionedIds([A, A, 'not-an-id', 42, null, `${A}'); drop`])).toEqual([A])
    expect(mentionedIds('nope')).toEqual([])
    const many = Array.from({ length: 30 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(mentionedIds(many)).toHaveLength(MAX_PER_KIND)
  })
})

describe('buildMentionedRecordsBlock', () => {
  it('is nothing with nothing mentioned, or nothing found', async () => {
    const { client } = fakeClient({})
    expect(await buildMentionedRecordsBlock(client, { workspaceId: 'ws', userId: 'u' })).toBeNull()
    expect(await buildMentionedRecordsBlock(client, { workspaceId: 'ws', userId: 'u', actionIds: [A] })).toBeNull()
  })

  it('lists each record with the tool that reads it, fenced as data', async () => {
    const { client } = fakeClient({
      actions: [{ id: A, title: 'Pricing page copy', identifier: 'GEN-42', workflow_state: { name: 'Todo' } }],
      document: [{ id: D, title: 'Pricing v3' }],
      projects: [{ id: P, name: 'Website', status: 'active' }],
      initiative: [{ id: I, name: 'Q4 launch', status: 'planned' }],
    })
    const block = await buildMentionedRecordsBlock(client, {
      workspaceId: 'ws',
      userId: 'u',
      actionIds: [A],
      documentIds: [D],
      projectIds: [P],
      initiativeIds: [I],
    })
    expect(block).toContain('## Mentioned records')
    expect(block).toContain(`- Action GEN-42 "Pricing page copy" (Todo): get_action(action_id: ${A})`)
    expect(block).toContain(`- Doc "Pricing v3": get_document(document_id: ${D})`)
    expect(block).toContain(`- Project "Website" (active): get_project_context(project_id: ${P})`)
    expect(block).toContain(`- Initiative "Q4 launch" (planned): get_initiative(initiative_id: ${I})`)
    expect(block).toContain('[UNTRUSTED WORKSPACE CONTENT')
  })

  it('fences every read to the workspace, and a doc to shared or the caller’s own', async () => {
    const { client, calls } = fakeClient({ document: [{ id: D, title: 'x' }] })
    await buildMentionedRecordsBlock(client, { workspaceId: 'ws-1', userId: 'u', actionIds: [A], documentIds: [D], projectIds: [P], initiativeIds: [I] })
    for (const table of ['actions', 'document', 'projects', 'initiative']) {
      expect(calls.some((c) => c.table === table && c.method === 'eq' && c.args[0] === 'workspace_id' && c.args[1] === 'ws-1')).toBe(true)
    }
    expect(calls.some((c) => c.table === 'document' && c.method === 'or' && c.args[0] === 'visibility.eq.workspace,created_by.eq.member-1')).toBe(true)
  })

  it('reads only shared docs for a run that can’t read private data, without asking who the member is', async () => {
    const { client, calls } = fakeClient({ document: [{ id: D, title: 'Shared' }] })
    const lines = await gatherMentionedRecords(client, { workspaceId: 'ws-1', userId: 'u', documentIds: [D], privateDocs: false })
    expect(lines).toEqual([{ kind: 'document', id: D, line: `Doc "Shared": get_document(document_id: ${D})` }])
    expect(calls.some((c) => c.table === 'member')).toBe(false)
    expect(calls.some((c) => c.table === 'document' && c.method === 'eq' && c.args[0] === 'visibility' && c.args[1] === 'workspace')).toBe(true)
  })

  it('reads only shared docs for someone with no member row', async () => {
    const { client, calls } = fakeClient({ document: [] }, null)
    await buildMentionedRecordsBlock(client, { workspaceId: 'ws-1', userId: 'u', documentIds: [D] })
    expect(calls.some((c) => c.table === 'document' && c.method === 'eq' && c.args[0] === 'visibility' && c.args[1] === 'workspace')).toBe(true)
  })
})

describe('Studio videos mentioned', () => {
  const V = '55555555-5555-4555-8555-555555555555'

  it('lists a video with get_studio_video, fenced to the workspace and never one in the trash', async () => {
    const { client, calls } = fakeClient({ studio_video: [{ id: V, title: 'Launch teaser', status: 'review' }] }, { id: 'member-1', role: 'member' })
    const lines = await gatherMentionedRecords(client, { workspaceId: 'ws-1', userId: 'u', studioVideoIds: [V, 'nope'] })
    expect(lines).toEqual([{ kind: 'studio_video', id: V, line: `Studio video "Launch teaser" (review): get_studio_video(video_id: ${V})` }])
    const reads = calls.filter((c) => c.table === 'studio_video')
    expect(reads).toContainEqual({ table: 'studio_video', method: 'eq', args: ['workspace_id', 'ws-1'] })
    expect(reads).toContainEqual({ table: 'studio_video', method: 'in', args: ['id', [V]] })
    expect(reads).toContainEqual({ table: 'studio_video', method: 'is', args: ['archived_at', null] })
  })

  it('reads no video for a workspace guest or someone outside it', async () => {
    for (const member of [{ id: 'member-2', role: 'guest' }, null]) {
      const { client, calls } = fakeClient({ studio_video: [{ id: V, title: 'Launch teaser', status: 'draft' }] }, member)
      expect(await gatherMentionedRecords(client, { workspaceId: 'ws-1', userId: 'u', studioVideoIds: [V] })).toEqual([])
      expect(calls.some((c) => c.table === 'studio_video')).toBe(false)
    }
  })
})
