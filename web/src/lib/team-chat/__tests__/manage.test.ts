/**
 * Managing a conversation (migration 714, src/lib/team-chat/manage.ts and
 * store.ts canManageChannel): who is offered it, what a PATCH may carry, how
 * 714's answers and refusals come back, and the delete's files removed from
 * storage only under the chat's own folder, in batches, after the delete.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

vi.mock('server-only', () => ({}))

import { canManageChannel, listChannels, TeamChatError, teamChatErrorOf } from '../store'
import { deleteMeetingChat, meetingChatContents, parseChannelEdit, updateChannel } from '../manage'

const CH = '6f1c2a40-1111-4c2b-9a51-0d1e2f3a4b5c'

function rpcClient(answers: Record<string, { data: unknown; error: { code?: string; message?: string } | null }>) {
  const calls: Array<{ fn: string; args: unknown }> = []
  const client = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args })
      return answers[fn] ?? { data: null, error: { message: 'no such function' } }
    },
  } as unknown as SupabaseClient
  return { client, calls }
}

function storageClient(fail: (bucket: string) => boolean = () => false) {
  const removed: Array<{ bucket: string; names: string[] }> = []
  const client = {
    storage: {
      from: (bucket: string) => ({
        remove: async (names: string[]) => {
          removed.push({ bucket, names })
          return fail(bucket) ? { data: null, error: { message: 'storage down' } } : { data: [], error: null }
        },
      }),
    },
  } as unknown as SupabaseClient
  return { client, removed }
}

describe('who is offered Edit and Delete', () => {
  it('the creator of a channel or meeting chat; an owner or admin, any; never a DM', () => {
    expect(canManageChannel({ kind: 'channel', created_by: 'me' }, { memberId: 'me', role: 'member' })).toBe(true)
    expect(canManageChannel({ kind: 'channel', created_by: 'ana' }, { memberId: 'me', role: 'member' })).toBe(false)
    expect(canManageChannel({ kind: 'meeting', created_by: 'me' }, { memberId: 'me' })).toBe(true)
    expect(canManageChannel({ kind: 'meeting', created_by: 'ana' }, { memberId: 'me', role: 'admin' })).toBe(true)
    expect(canManageChannel({ kind: 'channel', created_by: null }, { memberId: 'me', role: 'owner' })).toBe(true)
    expect(canManageChannel({ kind: 'channel', created_by: null }, { memberId: 'me', role: 'guest' })).toBe(false)
    expect(canManageChannel({ kind: 'dm', created_by: 'me' }, { memberId: 'me', role: 'owner' })).toBe(false)
  })

  it('the list says it per conversation', async () => {
    const row = (id: string, kind: string, created_by: string | null, extra: Record<string, unknown> = {}) => ({
      id, workspace_id: 'ws', kind, name: kind === 'dm' ? null : id, topic: null, team_id: null, dm_key: kind === 'dm' ? 'me:ana' : null,
      last_message_at: new Date().toISOString(), archived_at: null, created_at: new Date().toISOString(), created_by, ...extra,
    })
    const tables = { team_chat_channel: [row('mine', 'channel', 'me'), row('theirs', 'channel', 'ana'), row('dm', 'dm', 'me')], team_chat_member: [], meeting: [] }
    const db = Object.assign(memoryDb(tables), { rpc: async () => ({ data: [], error: null }) }) as unknown as SupabaseClient
    const { channels } = await listChannels(db, { workspaceId: 'ws', memberId: 'me', role: 'member' })
    expect(Object.fromEntries(channels.map((c) => [c.id, c.can_manage]))).toEqual({ mine: true, theirs: false, dm: false })
  })
})

describe('a PATCH body', () => {
  it('tidies the name as a new channel’s is, and takes a topic or clears it', () => {
    expect(parseChannelEdit({ name: '  #Design   crit ' })).toEqual({ name: 'Design crit' })
    expect(parseChannelEdit({ topic: '  Reviews on Fridays ' })).toEqual({ topic: 'Reviews on Fridays' })
    expect(parseChannelEdit({ topic: '' })).toEqual({ topic: '' })
    expect(parseChannelEdit({ topic: null })).toEqual({ topic: '' })
    expect(parseChannelEdit({ name: 'ok', topic: 'why' })).toEqual({ name: 'ok', topic: 'why' })
  })

  it('refuses an empty or long name, a long topic, a topic that isn’t words, and nothing to change', () => {
    expect(parseChannelEdit({ name: '   ' })).toMatch(/name/)
    expect(parseChannelEdit({ name: '#' })).toMatch(/name/)
    expect(parseChannelEdit({ name: 'x'.repeat(81) })).toMatch(/80/)
    expect(parseChannelEdit({ topic: 'x'.repeat(251) })).toMatch(/250/)
    expect(parseChannelEdit({ topic: 7 })).toMatch(/words/)
    expect(parseChannelEdit({})).toMatch(/Nothing/)
  })
})

describe('714’s answers', () => {
  it('an edit sends the name and topic, null for what stays, and returns the row', async () => {
    const { client, calls } = rpcClient({ team_chat_update_channel: { data: [{ id: CH, kind: 'channel', name: 'Design crit', topic: null }], error: null } })
    expect(await updateChannel(client, CH, { name: 'Design crit' })).toEqual({ id: CH, kind: 'channel', name: 'Design crit', topic: null })
    expect(calls).toEqual([{ fn: 'team_chat_update_channel', args: { ch: CH, new_name: 'Design crit', new_topic: null } }])
  })

  it('its refusals as codes: a name taken, not theirs, not readable, a DM, a live call', async () => {
    const codeOf = async (code: string) => {
      const { client } = rpcClient({ team_chat_update_channel: { data: null, error: { code, message: 'x' } } })
      return updateChannel(client, CH, { name: 'x' }).then(
        () => 'ok',
        (e: TeamChatError) => e.code,
      )
    }
    expect(await codeOf('23505')).toBe('conflict')
    expect(await codeOf('42501')).toBe('forbidden')
    expect(await codeOf('P0002')).toBe('not_found')
    expect(await codeOf('22023')).toBe('bad_request')
    expect(teamChatErrorOf({ code: '55000' }, 'delete').code).toBe('busy')
  })

  it('the contents, counted', async () => {
    const { client } = rpcClient({
      team_chat_meeting_chat_contents: { data: [{ messages: 12, files: 2, polls: 1, calls: 3, notes_kept: 2, live_call: false, link_current: true, booked: false }], error: null },
    })
    expect(await meetingChatContents(client, CH)).toEqual({ messages: 12, files: 2, polls: 1, calls: 3, notesKept: 2, liveCall: false, linkCurrent: true, booked: false })
  })
})

describe('deleting a meeting chat', () => {
  it('runs as the person, then removes only its own folder’s objects from the two buckets, 100 at a time', async () => {
    const files = Array.from({ length: 150 }, (_, i) => ({ bucket: 'team-chat-files', object_name: `${CH}/user/${i}.pdf` }))
    const { client, calls } = rpcClient({
      team_chat_delete_meeting_chat: {
        data: [
          ...files,
          { bucket: 'team-call-recordings', object_name: `${CH}/call/recording/r.mp4` },
          // Never another conversation's, never another bucket's.
          { bucket: 'team-chat-files', object_name: `other/${CH}/x.pdf` },
          { bucket: 'attachments', object_name: `${CH}/x.pdf` },
        ],
        error: null,
      },
    })
    const storage = storageClient()
    expect(await deleteMeetingChat(client, storage.client, CH)).toEqual({ filesRemoved: 151, filesLeft: 0 })
    expect(calls.map((c) => c.fn)).toEqual(['team_chat_delete_meeting_chat'])
    expect(storage.removed.map((r) => [r.bucket, r.names.length])).toEqual([
      ['team-chat-files', 100],
      ['team-chat-files', 50],
      ['team-call-recordings', 1],
    ])
    expect(storage.removed.flatMap((r) => r.names).every((n) => n.startsWith(`${CH}/`))).toBe(true)
  })

  it('a refused delete removes nothing; a storage failure is counted, never thrown', async () => {
    const refused = rpcClient({ team_chat_delete_meeting_chat: { data: null, error: { code: '55000', message: 'live' } } })
    const storage = storageClient()
    await expect(deleteMeetingChat(refused.client, storage.client, CH)).rejects.toMatchObject({ code: 'busy' })
    expect(storage.removed).toEqual([])

    const ok = rpcClient({ team_chat_delete_meeting_chat: { data: [{ bucket: 'team-call-recordings', object_name: `${CH}/c/r.mp4` }], error: null } })
    const down = storageClient(() => true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await deleteMeetingChat(ok.client, down.client, CH)).toEqual({ filesRemoved: 0, filesLeft: 1 })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
