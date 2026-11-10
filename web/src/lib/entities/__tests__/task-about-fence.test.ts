/**
 * "Make a task from this" through the REAL mention fence (task-about.test.ts
 * mocks it): a task is never made about a record of another workspace,
 * someone else's private document, or someone else's calendar event, and a
 * fence that can't read fails closed. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { canMakeTaskAbout } from '../task-about'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '22222222-2222-4222-8222-222222222222'
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const THEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MY_MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const THEIR_MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const id = (n: number) => `0f8fad5b-d9cb-469f-a165-${String(n).padStart(12, '0')}`
const SHARED_DOC = id(1)
const MY_PRIVATE_DOC = id(2)
const THEIR_PRIVATE_DOC = id(3)
const OTHER_WS_DOC = id(4)
const MY_EVENT = id(5)
const THEIR_EVENT = id(6)

function db(): SupabaseClient {
  return memoryDb({
    member: [
      { id: MY_MEMBER, user_id: ME, workspace_id: WS },
      { id: THEIR_MEMBER, user_id: THEM, workspace_id: WS },
    ],
    document: [
      { id: SHARED_DOC, workspace_id: WS, visibility: 'workspace', created_by: THEIR_MEMBER },
      { id: MY_PRIVATE_DOC, workspace_id: WS, visibility: 'private', created_by: MY_MEMBER },
      { id: THEIR_PRIVATE_DOC, workspace_id: WS, visibility: 'private', created_by: THEIR_MEMBER },
      { id: OTHER_WS_DOC, workspace_id: OTHER_WS, visibility: 'workspace', created_by: THEIR_MEMBER },
    ],
    local_calendar_event: [
      { id: MY_EVENT, workspace_id: WS, user_id: ME },
      { id: THEIR_EVENT, workspace_id: WS, user_id: THEM },
    ],
  })
}

const scope = { workspaceId: WS, userId: ME }

describe('canMakeTaskAbout (the real fence)', () => {
  it('allows a workspace document, and the person’s own private one', async () => {
    expect(await canMakeTaskAbout(db(), scope, { type: 'document', id: SHARED_DOC })).toBe(true)
    expect(await canMakeTaskAbout(db(), scope, { type: 'document', id: MY_PRIVATE_DOC })).toBe(true)
  })

  it('refuses someone else’s private document', async () => {
    expect(await canMakeTaskAbout(db(), scope, { type: 'document', id: THEIR_PRIVATE_DOC })).toBe(false)
  })

  it('refuses a record of another workspace, even one its members can all read', async () => {
    expect(await canMakeTaskAbout(db(), scope, { type: 'document', id: OTHER_WS_DOC })).toBe(false)
  })

  it('allows the person’s own calendar event and refuses a teammate’s', async () => {
    expect(await canMakeTaskAbout(db(), scope, { type: 'calendar_event', id: MY_EVENT })).toBe(true)
    expect(await canMakeTaskAbout(db(), scope, { type: 'calendar_event', id: THEIR_EVENT })).toBe(false)
  })

  it('fails closed when the fence cannot read', async () => {
    const broken = { from: () => { throw new Error('db down') } } as unknown as SupabaseClient
    expect(await canMakeTaskAbout(broken, scope, { type: 'document', id: SHARED_DOC })).toBe(false)
  })
})
