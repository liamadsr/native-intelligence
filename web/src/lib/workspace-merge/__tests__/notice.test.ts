/**
 * The notice destination members get after a merge: who hears it (everyone
 * in the destination but the person who merged), what it says (the counts
 * ride in the title, the only line the agent event carries), and that a
 * failure to tell them never fails the merge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const hoisted = vi.hoisted(() => ({ createNotificationsForMany: vi.fn() }))
vi.mock('@/lib/notifications', () => ({ createNotificationsForMany: hoisted.createNotificationsForMany }))

import { announceWorkspaceMerge, mergeAnnouncementBody, mergeAnnouncementTitle, mergeCountsLine } from '../notice'

const DST = '22222222-2222-4222-8222-222222222222'

function service(result: { data: unknown; error: unknown }) {
  const eq = vi.fn(async () => result)
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { client: { from } as unknown as SupabaseClient, from, select, eq }
}

describe('the wording', () => {
  it('names the tables people recognise, biggest first, with plurals', () => {
    expect(mergeCountsLine({ actions: 12, captures: 1, document: 0, member: 3, agent_log: 999 })).toBe('12 actions, 1 capture')
    expect(mergeCountsLine({ company: 2, contact: 1500 })).toBe('1,500 contacts, 2 companies')
    expect(mergeCountsLine({})).toBe('')
  })

  it('the title carries the counts (the agent event keeps only the title); the body says nothing was deleted', () => {
    expect(mergeAnnouncementTitle('Coherix', 'Dial8', { actions: 2, member: 1 })).toBe('Coherix was merged into Dial8: 2 actions came over.')
    expect(mergeAnnouncementTitle('Coherix', 'Dial8', {})).toBe('Coherix was merged into Dial8.')
    expect(mergeAnnouncementBody({ actions: 2 })).toBe('2 actions came over. Nothing was deleted.')
    expect(mergeAnnouncementBody({})).toBe('Nothing was deleted.')
  })
})

describe('announceWorkspaceMerge', () => {
  beforeEach(() => hoisted.createNotificationsForMany.mockReset().mockResolvedValue(undefined))

  const base = {
    destinationWorkspaceId: DST,
    actorMemberId: 'm-actor',
    sourceName: 'Coherix',
    destinationName: 'Dial8',
    mergeId: 'merge-1',
    rowsBefore: { actions: 2 },
  }

  it('tells every destination member but the actor, as one grouped workspace_merged notice', async () => {
    const s = service({ data: [{ id: 'm-actor' }, { id: 'm-b' }, { id: 'm-c' }], error: null })
    const told = await announceWorkspaceMerge(s.client, base)
    expect(told).toBe(2)
    expect(s.from).toHaveBeenCalledWith('member')
    expect(s.eq).toHaveBeenCalledWith('workspace_id', DST)
    expect(hoisted.createNotificationsForMany).toHaveBeenCalledWith(['m-b', 'm-c'], {
      workspaceId: DST,
      type: 'workspace_merged',
      title: 'Coherix was merged into Dial8: 2 actions came over.',
      body: '2 actions came over. Nothing was deleted.',
      actorId: 'm-actor',
      groupKey: 'workspace_merged:merge-1',
      metadata: { merge_id: 'merge-1', source_name: 'Coherix', rows_before: { actions: 2 } },
    })
  })

  it('a one-person destination has nobody to tell', async () => {
    const s = service({ data: [{ id: 'm-actor' }], error: null })
    expect(await announceWorkspaceMerge(s.client, base)).toBe(0)
    expect(hoisted.createNotificationsForMany).not.toHaveBeenCalled()
  })

  it('never throws: a failed member read or a failed insert is logged and counted as nobody told', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bad = service({ data: null, error: { message: 'down' } })
    expect(await announceWorkspaceMerge(bad.client, base)).toBe(0)

    hoisted.createNotificationsForMany.mockRejectedValueOnce(new Error('insert failed'))
    const s = service({ data: [{ id: 'm-actor' }, { id: 'm-b' }], error: null })
    expect(await announceWorkspaceMerge(s.client, base)).toBe(0)
  })
})
