/**
 * The one action layer: each action calls the kind's own route with the verb
 * and body its descriptor names, tells the app on the entity event bus, and
 * toasts with an Undo that puts things back. Fixtures are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import {
  archiveEntity,
  copyEntityId,
  copyEntityLink,
  loadShareChannels,
  makeTaskFromEntity,
  openEntity,
  renameEntity,
  restoreEntity,
  runEntityAction,
  shareEntityToChannel,
  shareMentionLabel,
  taskTitleFor,
  type EntityActionDeps,
} from '../actions'

const DOC = { type: 'document', id: 'doc-1', label: 'Q4 renewals plan' }

interface Call {
  url: string
  method: string
  body: unknown
  headers: Record<string, string>
}

let calls: Call[]
let replies: Array<{ status: number; body: unknown }>
let toasts: Array<{ kind: 'success' | 'error'; message: string; undo?: () => void; open?: () => void }>
let events: Array<{ kind: 'updated' | 'deleted' | 'created'; entityType: string; id?: string; fields?: Record<string, unknown> }>
let copied: string[]
let opened: unknown[]
let deps: EntityActionDeps

beforeEach(() => {
  calls = []
  replies = []
  toasts = []
  events = []
  copied = []
  opened = []
  deps = {
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      const reply = replies.shift() ?? { status: 200, body: { success: true } }
      return new Response(JSON.stringify(reply.body), { status: reply.status })
    },
    toast: {
      success: (message, opts) => {
        const action = opts?.action
        toasts.push({
          kind: 'success',
          message,
          ...(action?.label === 'Undo' ? { undo: action.onClick } : {}),
          ...(action?.label === 'Open' ? { open: action.onClick } : {}),
        })
      },
      error: (message) => toasts.push({ kind: 'error', message }),
    },
    copy: async (text) => {
      copied.push(text)
      return true
    },
    openTarget: (target) => {
      opened.push(target)
      return true
    },
    emitUpdated: (d) => events.push({ kind: 'updated', ...d }),
    emitDeleted: (d) => events.push({ kind: 'deleted', ...d }),
    emitCreated: (d) => events.push({ kind: 'created', ...d }),
    origin: () => 'https://app.example.test',
  }
})

/** Let an undo's async write finish. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('archive and restore', () => {
  it("archives a document through its route's DELETE, tells every list, and undoes with a PATCH", async () => {
    expect(await archiveEntity(DOC, {}, deps)).toBe(true)
    expect(calls).toEqual([expect.objectContaining({ url: '/api/account/documents/doc-1', method: 'DELETE', body: undefined })])
    expect(events).toEqual([
      { kind: 'updated', entityType: 'document', id: 'doc-1', fields: { status: 'archived' } },
      { kind: 'deleted', entityType: 'document', id: 'doc-1' },
    ])
    expect(toasts[0]).toMatchObject({ kind: 'success', message: 'Archived “Q4 renewals plan”' })

    toasts[0].undo!()
    await settle()
    expect(calls[1]).toMatchObject({ url: '/api/account/documents/doc-1', method: 'PATCH', body: { status: 'active' } })
    expect(events.slice(2)).toEqual([
      { kind: 'updated', entityType: 'document', id: 'doc-1', fields: { status: 'active' } },
      { kind: 'created', entityType: 'document', id: 'doc-1' },
    ])
  })

  it("archives a project by its is_archived flag", async () => {
    await archiveEntity({ type: 'project', id: 'p-1', label: 'Fernhill launch' }, {}, deps)
    expect(calls[0]).toMatchObject({ url: '/api/account/projects/p-1', method: 'PATCH', body: { is_archived: true } })
    toasts[0].undo!()
    await settle()
    expect(calls[1]).toMatchObject({ method: 'PATCH', body: { is_archived: false } })
  })

  it("an initiative's undo puts back the status it had", async () => {
    await archiveEntity({ type: 'initiative', id: 'i-1', label: 'Grow the north region' }, { status: 'planned' }, deps)
    expect(calls[0]).toMatchObject({ url: '/api/account/initiatives/i-1', method: 'PATCH', body: { status: 'archived' } })
    toasts[0].undo!()
    await settle()
    expect(calls[1]).toMatchObject({ body: { status: 'planned' } })
  })

  it("restores a campaign to its fallback when its status before is unknown, and undoes back to archived", async () => {
    await restoreEntity({ type: 'campaign', id: 'cm-1', label: 'Spring tune-ups' }, {}, deps)
    expect(calls[0]).toMatchObject({ url: '/api/account/campaigns/cm-1', method: 'PATCH', body: { status: 'paused' } })
    expect(events.map((e) => e.kind)).toEqual(['updated', 'created'])
    toasts[0].undo!()
    await settle()
    expect(calls[1]).toMatchObject({ method: 'PATCH', body: { status: 'archived' } })
  })

  it("never writes for a kind with no archive", async () => {
    expect(await archiveEntity({ type: 'contact', id: 'c-1', label: 'Maya Chen' }, {}, deps)).toBe(false)
    expect(calls).toEqual([])
    expect(events).toEqual([])
  })

  it("says the route's own refusal and changes nothing locally", async () => {
    replies.push({ status: 404, body: { error: 'Capture not found' } })
    expect(await archiveEntity({ type: 'capture', id: 'cap-1', label: 'Standup' }, {}, deps)).toBe(false)
    expect(toasts).toEqual([{ kind: 'error', message: 'Capture not found' }])
    expect(events).toEqual([])
  })

  it("writes a record from another workspace in its own workspace", async () => {
    await archiveEntity({ ...DOC, workspaceId: 'ws-2' }, {}, deps)
    expect(calls[0].headers['x-workspace-id']).toBe('ws-2')
  })
})

describe('rename', () => {
  it("PATCHes the kind's own title field and undoes back to the old name", async () => {
    expect(await renameEntity({ type: 'contact', id: 'c-1', label: 'Maya Chen' }, '  Maya   Chen-Ruiz ', deps)).toBe(true)
    expect(calls[0]).toMatchObject({ url: '/api/account/contacts/c-1', method: 'PATCH', body: { full_name: 'Maya Chen-Ruiz' } })
    expect(events[0]).toEqual({ kind: 'updated', entityType: 'contact', id: 'c-1', fields: { full_name: 'Maya Chen-Ruiz' } })
    toasts[0].undo!()
    await settle()
    expect(calls[1]).toMatchObject({ body: { full_name: 'Maya Chen' } })
    expect(events[1]).toEqual({ kind: 'updated', entityType: 'contact', id: 'c-1', fields: { full_name: 'Maya Chen' } })
  })

  it('does nothing for an empty or unchanged name, or a kind not renamed from a menu', async () => {
    expect(await renameEntity(DOC, '   ', deps)).toBe(false)
    expect(await renameEntity(DOC, 'Q4 renewals plan', deps)).toBe(false)
    expect(await renameEntity({ type: 'calendar_event', id: 'e-1', label: 'Sync' }, 'Weekly sync', deps)).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('open and copy', () => {
  it("opens the record's card", () => {
    expect(openEntity({ type: 'deal', id: 'd-1', label: 'Fernhill renewal' }, {}, deps)).toBe(true)
    expect(opened).toEqual([{ type: 'deal', id: 'd-1', title: 'Fernhill renewal' }])
    expect(openEntity({ type: 'claim', id: 'cl-1', label: 'x' }, {}, deps)).toBe(false)
  })

  it('copies the deep link and the id', async () => {
    await copyEntityLink(DOC, deps)
    await copyEntityId(DOC, deps)
    expect(copied).toEqual(['https://app.example.test/account?document=doc-1', 'document doc-1'])
  })
})

describe('share to a channel', () => {
  it("posts a message that @-mentions the record through team chat's own post, and undoes by deleting it", async () => {
    replies.push({ status: 200, body: { message: { id: 'msg-1' } } })
    expect(await shareEntityToChannel(DOC, { id: 'ch-1', name: 'sales', kind: 'channel' }, deps)).toBe(true)
    expect(calls[0]).toMatchObject({
      url: '/api/account/team-chat/channels/ch-1/messages',
      method: 'POST',
      body: { body: '@Q4 renewals plan', records: [{ type: 'document', id: 'doc-1', label: 'Q4 renewals plan' }] },
    })
    expect(toasts[0].message).toBe('Shared to #sales')
    toasts[0].undo!()
    await settle()
    expect(calls[1]).toMatchObject({ url: '/api/account/team-chat/messages/msg-1', method: 'DELETE' })
  })

  it("keeps the label the mention keeps (whitespace folded, capped)", () => {
    expect(shareMentionLabel('  Q4\n renewals  ')).toBe('Q4 renewals')
    expect(shareMentionLabel('x'.repeat(300))).toHaveLength(120)
  })

  it('lists only channels (no DMs, nothing archived)', async () => {
    replies.push({
      status: 200,
      body: {
        channels: [
          { id: 'ch-1', name: 'sales', kind: 'channel', archived_at: null },
          { id: 'dm-1', name: null, kind: 'dm', archived_at: null },
          { id: 'ch-2', name: 'old', kind: 'channel', archived_at: '2026-10-01T00:00:00Z' },
        ],
      },
    })
    expect(await loadShareChannels(null, deps)).toEqual([{ id: 'ch-1', name: 'sales', kind: 'channel' }])
    expect(calls[0].headers).toEqual({})
  })

  it("lists a record from another workspace with that workspace's channels, and posts there", async () => {
    replies.push({ status: 200, body: { channels: [{ id: 'ch-9', name: 'ops', kind: 'channel', archived_at: null }] } })
    const channels = await loadShareChannels('ws-2', deps)
    expect(calls[0]).toMatchObject({ url: '/api/account/team-chat/channels', headers: { 'x-workspace-id': 'ws-2' } })
    replies.push({ status: 200, body: { message: { id: 'msg-9' } } })
    await shareEntityToChannel({ ...DOC, workspaceId: 'ws-2' }, channels[0], deps)
    expect(calls[1].headers['x-workspace-id']).toBe('ws-2')
  })

  it("says the post's refusal (a channel the person can't post in) and offers no undo", async () => {
    replies.push({ status: 404, body: { error: 'Not found' } })
    expect(await shareEntityToChannel(DOC, { id: 'ch-x', name: 'leadership', kind: 'channel' }, deps)).toBe(false)
    expect(toasts).toEqual([{ kind: 'error', message: 'Not found' }])
  })

  it('never shares a kind that is not shared', async () => {
    expect(await shareEntityToChannel({ type: 'calendar_event', id: 'e-1', label: 'Sync' }, { id: 'ch-1', name: 'sales', kind: 'channel' }, deps)).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('make a task from this', () => {
  it("creates an action about the record through the actions route, tells the lists and the record's references", async () => {
    replies.push({ status: 200, body: { action: { id: 'a-9', title: 'Follow up: Q4 renewals plan' }, about_linked: true } })
    expect(await makeTaskFromEntity(DOC, deps)).toBe('a-9')
    expect(calls[0]).toMatchObject({
      url: '/api/account/actions',
      method: 'POST',
      body: { title: 'Follow up: Q4 renewals plan', about: { type: 'document', id: 'doc-1' } },
    })
    expect(events).toEqual([
      { kind: 'created', entityType: 'action', id: 'a-9' },
      { kind: 'created', entityType: 'entity_link' },
    ])
    toasts[0].open!()
    expect(opened).toEqual([{ type: 'action', id: 'a-9', title: 'Follow up: Q4 renewals plan' }])
  })

  it("says the route's refusal (a record the person can't see) and tells no list", async () => {
    replies.push({ status: 400, body: { error: 'about must be a record you can see in this workspace' } })
    expect(await makeTaskFromEntity(DOC, deps)).toBeNull()
    expect(toasts).toEqual([{ kind: 'error', message: 'about must be a record you can see in this workspace' }])
    expect(events).toEqual([])
  })

  it('makes none from a task', async () => {
    expect(await makeTaskFromEntity({ type: 'action', id: 'a-1', label: 'Call back' }, deps)).toBeNull()
    expect(calls).toEqual([])
  })

  it('titles the task after what it follows up on', () => {
    expect(taskTitleFor('  Weekly   sync ')).toBe('Follow up: Weekly sync')
    expect(taskTitleFor('')).toBe('Follow up: this')
  })
})

describe('runEntityAction', () => {
  it('routes each direct action', async () => {
    await runEntityAction('copy_id', DOC, {}, deps)
    await runEntityAction('archive', DOC, {}, deps)
    expect(copied).toEqual(['document doc-1'])
    expect(calls[0]).toMatchObject({ method: 'DELETE' })
  })
})
