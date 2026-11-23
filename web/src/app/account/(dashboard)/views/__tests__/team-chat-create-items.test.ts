import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ opened: [] as unknown[] }))
vi.mock('@/lib/create/open-create', () => ({
  openCreateDialog: (req: unknown) => h.opened.push(['create', req]),
  openTaskComposer: (src: unknown) => h.opened.push(['task', src]),
}))

import { teamChatCreateItems } from '../team-chat-create-items'

const channel = { id: 'ch', kind: 'channel' as const, archived_at: null }
beforeEach(() => {
  h.opened = []
})

describe('teamChatCreateItems', () => {
  it('lists task, doc and call in order when all are on offer (the box adds its own poll and form)', () => {
    const items = teamChatCreateItems({ channel, label: '#launch', source: null, inThread: false, calls: { available: true, start: () => {} } })
    expect(items.map((i) => i.id)).toEqual(['task', 'document', 'call'])
  })

  it('a task comes from the latest message, linked back to it', () => {
    const items = teamChatCreateItems({ channel, label: '#launch', source: { id: 'm1', body: 'Ship the pricing page by Friday', deleted_at: null }, inThread: false })
    items.find((i) => i.id === 'task')!.onSelect()
    expect(h.opened).toHaveLength(1)
    const [kind, src] = h.opened[0] as [string, { type: string; id: string; title: string }]
    expect(kind).toBe('task')
    expect(src.type).toBe('team_chat_message')
    expect(src.id).toBe('m1')
    expect(src.title).toContain('Ship the pricing page')
  })

  it('with no message to come from, a plain task composer', () => {
    teamChatCreateItems({ channel, label: '#launch', source: { id: 'm1', body: '', deleted_at: '2026-11-23T00:00:00Z' }, inThread: false })
      .find((i) => i.id === 'task')!
      .onSelect()
    expect(h.opened).toEqual([['create', { type: 'action' }]])
  })

  it('a doc opens the doc composer', () => {
    teamChatCreateItems({ channel, label: '#launch', source: null, inThread: false }).find((i) => i.id === 'document')!.onSelect()
    expect(h.opened).toEqual([['create', { type: 'document' }]])
  })

  it('no call from a thread, where calls are off, or in an archived channel', () => {
    const calls = { available: true, start: vi.fn() }
    expect(teamChatCreateItems({ channel, label: '#l', source: null, inThread: true, calls }).some((i) => i.id === 'call')).toBe(false)
    expect(teamChatCreateItems({ channel, label: '#l', source: null, inThread: false, calls: { ...calls, available: false } }).some((i) => i.id === 'call')).toBe(false)
    expect(teamChatCreateItems({ channel: { ...channel, archived_at: 'x' }, label: '#l', source: null, inThread: false, calls }).some((i) => i.id === 'call')).toBe(false)
    const item = teamChatCreateItems({ channel, label: '#l', source: null, inThread: false, calls }).find((i) => i.id === 'call')!
    item.onSelect()
    expect(calls.start).toHaveBeenCalled()
  })

  it('no call without the calls handed in', () => {
    const ids = teamChatCreateItems({ channel, label: '#l', source: null, inThread: false }).map((i) => i.id)
    expect(ids).toEqual(['task', 'document'])
  })
})
