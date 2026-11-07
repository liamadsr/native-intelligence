// @vitest-environment jsdom
/**
 * One face (docs/plans/always-on-agent.md §2c): a notice an area face wrote
 * speaks as the agent on the client. Its face is the agent's, its banner's and
 * toast's title the agent's name (the roster carries the person's saved
 * assistant name), its banner stacks and opens on the agent (its workspace's
 * Assistant), and a request to open its bubble goes to the agent. A notice of
 * any other bot is untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ channel: () => ({}), removeChannel: () => {} }) }))
vi.mock('@/app/account/workspace-switcher', () => ({ useCurrentMemberId: () => null, useWorkspaces: () => ({ workspaces: [] }) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => false }))
vi.mock('@/lib/tauri-bridge', () => ({ tauriBridge: {} }))
vi.mock('@/lib/reminders/client', () => ({ emitReminderChanged: vi.fn() }))
vi.mock('@/lib/sounds/triggers', () => ({ announceNotification: vi.fn() }))

import { __resetNoticeFacesForTests, noticeFaceOf, noticeSpeakerOf, publishNoticeFaces } from '../notice-faces'
import { nativeNotificationArgs, toastCopy, type Notification } from '@/app/account/notification-context'

const ROSTER = [
  // As the shared source hands it on: the Assistant already in the agent's look and name.
  { id: 'as-1', workspace_id: 'w1', name: 'Joseph', bot_character: 'chat' as const, is_system: true, system_key: 'assistant' },
  { id: 'mail-1', workspace_id: 'w1', name: 'Mail', bot_character: 'mail' as const, is_system: true, system_key: 'mail' },
  { id: 'writer', workspace_id: 'w1', name: 'Writer', bot_character: 'writer' as const, is_system: false, system_key: null },
  // An area face whose workspace's Assistant isn't held: nothing to speak as.
  { id: 'mail-2', workspace_id: 'w2', name: 'Mail', bot_character: 'mail' as const, is_system: true, system_key: 'mail' },
]

function notice(teammateId: string, name: string): Notification {
  return {
    id: `n-${teammateId}`,
    type: 'work_item_review',
    workspace_id: 'w1',
    title: 'Plain title',
    body: 'Plain body',
    metadata: { teammate_id: teammateId, teammate_name: name, sentence: 'I drafted two replies.', work_item_id: 'wi-1' },
    target_type: null,
    target_id: null,
    context_type: null,
    context_id: null,
    is_read: false,
    created_at: '2026-10-14T08:00:00.000Z',
  } as unknown as Notification
}

afterEach(() => __resetNoticeFacesForTests())

describe('an area face’s notice speaks as the agent', () => {
  it('wears the agent’s face and names the agent', () => {
    publishNoticeFaces(ROSTER)
    expect(noticeFaceOf('mail-1')).toBe('chat')
    expect(noticeSpeakerOf('mail-1')).toEqual({ teammateId: 'as-1', name: 'Joseph' })
    // Any other bot speaks as itself.
    expect(noticeFaceOf('writer')).toBe('writer')
    expect(noticeSpeakerOf('writer')).toBeNull()
    expect(noticeSpeakerOf('as-1')).toBeNull()
    // No Assistant held for its workspace: no face, nobody to speak as.
    expect(noticeFaceOf('mail-2')).toBeNull()
    expect(noticeSpeakerOf('mail-2')).toBeNull()
  })

  it('its toast and banner are titled with the agent’s name, and the banner stacks on the agent', () => {
    publishNoticeFaces(ROSTER)
    expect(toastCopy(notice('mail-1', 'Mail'))).toEqual({ title: 'Joseph', description: 'I drafted two replies.' })
    const args = nativeNotificationArgs(notice('mail-1', 'Mail'))
    expect(args.title).toBe('Joseph')
    expect(args.threadId).toBe('as-1')
    expect(JSON.parse(args.payload).bot).toMatchObject({ teammate_id: 'as-1', face: 'chat', work_item_id: 'wi-1' })
  })

  it('another bot’s notice is untouched', () => {
    publishNoticeFaces(ROSTER)
    expect(toastCopy(notice('writer', 'Writer'))).toEqual({ title: 'Writer', description: 'I drafted two replies.' })
    const args = nativeNotificationArgs(notice('writer', 'Writer'))
    expect(args.threadId).toBe('writer')
    expect(JSON.parse(args.payload).bot).toMatchObject({ teammate_id: 'writer', face: 'writer' })
  })
})
