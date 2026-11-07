/**
 * The visibility fence restates RLS for service-role reads
 * (./visibility-fence.ts). These pin the person-shaped facts it is built from
 * and that it fails closed; the end-to-end rows and counts are pinned through
 * the chat cards in src/lib/ai/tools/__tests__/show.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { resolveVisibilityFence, visibleContactIds, actionVisible } from '../visibility-fence'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function db() {
  const fake = makeFakeSupabase({ project: true })
  fake.seed('member', [
    { id: uuid(1), user_id: 'me', workspace_id: 'ws', role: 'member' },
    { id: uuid(2), user_id: 'mate', workspace_id: 'ws', role: 'member' },
    { id: uuid(3), user_id: 'boss', workspace_id: 'ws', role: 'owner' },
  ])
  fake.seed('team', [
    { id: uuid(10), workspace_id: 'ws', is_private: false },
    { id: uuid(11), workspace_id: 'ws', is_private: true },
    { id: uuid(12), workspace_id: 'ws', is_private: true },
  ])
  fake.seed('team_member', [
    { team_id: uuid(11), member_id: uuid(1) },
    { team_id: uuid(11), member_id: uuid(2) },
  ])
  fake.seed('contact_share', [{ contact_id: uuid(50), shared_with_member_id: null, shared_with_team_id: uuid(11) }])
  fake.seed('contact', [
    { id: uuid(50), workspace_id: 'ws', visibility: 'private', created_by_member_id: uuid(3) },
    { id: uuid(51), workspace_id: 'ws', visibility: 'team', created_by_member_id: uuid(2) },
    { id: uuid(52), workspace_id: 'ws', visibility: 'private', created_by_member_id: uuid(2) },
  ])
  return fake
}

describe('resolveVisibilityFence', () => {
  it('sees public teams and the private ones the person is on, teammates\' team contacts and contacts shared with their teams', async () => {
    const fake = db()
    const fence = await resolveVisibilityFence(fake as never, 'ws', 'me')
    expect(fence.visibleTeamIds.sort()).toEqual([uuid(10), uuid(11)])
    expect(actionVisible(fence, { team_id: uuid(12) })).toBe(false)
    expect([...(await visibleContactIds(fake as never, fence, [uuid(50), uuid(51), uuid(52)]))].sort()).toEqual([uuid(50), uuid(51)])
  })

  it('an owner sees every contact, still not a private team they are not on', async () => {
    const fence = await resolveVisibilityFence(db() as never, 'ws', 'boss')
    expect(fence.contactOr).toBeNull()
    expect(fence.visibleTeamIds).toEqual([uuid(10)])
  })

  it('fails closed for someone who is not a member', async () => {
    const fake = db()
    const fence = await resolveVisibilityFence(fake as never, 'ws', 'stranger')
    expect(fence.memberId).toBeNull()
    expect(fence.visibleTeamIds).toEqual([])
    expect((await visibleContactIds(fake as never, fence, [uuid(50)])).size).toBe(0)
  })
})
