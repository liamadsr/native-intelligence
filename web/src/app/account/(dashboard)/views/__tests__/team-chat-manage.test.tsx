// @vitest-environment jsdom
/**
 * Managing a conversation (migration 714, ../team-chat-manage.tsx): the
 * header's menu offers Edit for a channel, Rename and Delete for a meeting
 * chat, nothing for a DM or for someone who may not; the edit dialog sends
 * the tidied name and topic and shows a clash in words, still open; the
 * delete confirmation counts what goes and what stays, and stays off until
 * the counts are in and while a call is live. Radix's menu and dialogs are
 * replaced by plain always-open ones.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/dropdown-menu', async () => {
  const { createElement: e } = await import('react')
  type ItemProps = { children?: ReactNode; onSelect?: () => void; className?: string } & Record<string, unknown>
  return {
    DropdownMenu: ({ children }: { children?: ReactNode }) => e('div', null, children),
    DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => e('div', null, children),
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => e('div', { 'data-menu': '' }, children),
    DropdownMenuSeparator: () => e('hr'),
    DropdownMenuItem: ({ children, onSelect, className: _c, ...rest }: ItemProps) => e('button', { type: 'button', ...rest, onClick: () => onSelect?.() }, children),
  }
})
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: e } = await import('react')
  const pass = ({ children, open, onOpenChange: _o, className: _c, ...rest }: { children?: ReactNode; open?: boolean; onOpenChange?: unknown; className?: string } & Record<string, unknown>) =>
    open === false ? null : e('div', rest, children)
  return { Dialog: pass, DialogContent: pass, DialogHeader: pass, DialogFooter: pass, DialogTitle: pass, DialogDescription: pass }
})
vi.mock('@/components/ui/alert-dialog', async () => {
  const { createElement: e } = await import('react')
  const pass = ({ children, open, onOpenChange: _o, className: _c, ...rest }: { children?: ReactNode; open?: boolean; onOpenChange?: unknown; className?: string } & Record<string, unknown>) =>
    open === false ? null : e('div', rest, children)
  return {
    AlertDialog: pass,
    AlertDialogContent: pass,
    AlertDialogHeader: pass,
    AlertDialogFooter: pass,
    AlertDialogTitle: pass,
    AlertDialogDescription: pass,
    AlertDialogCancel: ({ children }: { children?: ReactNode }) => e('button', { type: 'button' }, children),
  }
})

import { DeleteConversationDialog, EditConversationDialog, TeamChatManageMenu, manageChoices, conversationGoes } from '../team-chat-manage'

let root: Root
let host: HTMLDivElement
const fetchMock = vi.fn()
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
const q = (sel: string) => host.querySelector<HTMLElement>(sel)
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response
const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0))
})
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('what is offered', () => {
  it('a channel: Edit and Delete; a meeting chat: Rename and Delete; Delete last; a DM or no right: nothing', () => {
    expect(manageChoices({ kind: 'channel', can_manage: true }).map((c) => c.what)).toEqual(['edit', 'delete'])
    expect(manageChoices({ kind: 'meeting', can_manage: true }).map((c) => c.what)).toEqual(['edit', 'delete'])
    expect(manageChoices({ kind: 'dm', can_manage: true })).toEqual([])
    expect(manageChoices({ kind: 'channel', can_manage: false })).toEqual([])
    expect(manageChoices({ kind: 'channel' })).toEqual([])
  })

  it('the menu draws them and says which', () => {
    const onManage = vi.fn()
    act(() => root.render(h(TeamChatManageMenu, { channel: { kind: 'meeting', can_manage: true }, onManage })))
    act(() => q('[data-team-chat-manage-item="delete"]')!.click())
    expect(onManage).toHaveBeenCalledWith('delete')
    act(() => root.render(h(TeamChatManageMenu, { channel: { kind: 'dm', can_manage: true }, onManage })))
    expect(q('[data-team-chat-manage]')).toBeNull()
  })
})

describe('EditConversationDialog', () => {
  const channel = { id: 'ch-1', kind: 'channel' as const, name: 'general', topic: 'Old topic' }

  it('sends the tidied name and the topic, and hands back the saved row', async () => {
    fetchMock.mockResolvedValue(json(200, { channel: { id: 'ch-1', kind: 'channel', name: 'Team room', topic: '' } }))
    const onSaved = vi.fn()
    const onOpenChange = vi.fn()
    act(() => root.render(h(EditConversationDialog, { channel, open: true, onOpenChange, onSaved })))
    act(() => type(q('[data-team-chat-edit-name]') as HTMLInputElement, '  #Team   room '))
    act(() => type(q('[data-team-chat-edit-topic]') as HTMLTextAreaElement, ''))
    await act(async () => q('[data-team-chat-edit-save]')!.click())
    await flush()
    expect(fetchMock).toHaveBeenCalledWith('/api/account/team-chat/channels/ch-1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Team room', topic: '' }) }))
    expect(onSaved).toHaveBeenCalledWith({ id: 'ch-1', kind: 'channel', name: 'Team room', topic: '' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('a name taken: the server’s words under the field, the dialog still open', async () => {
    fetchMock.mockResolvedValue(json(409, { error: 'There’s already a channel called #design. Pick another name.' }))
    const onSaved = vi.fn()
    const onOpenChange = vi.fn()
    act(() => root.render(h(EditConversationDialog, { channel, open: true, onOpenChange, onSaved })))
    act(() => type(q('[data-team-chat-edit-name]') as HTMLInputElement, 'design'))
    await act(async () => q('[data-team-chat-edit-save]')!.click())
    await flush()
    expect(q('[data-team-chat-edit-error]')?.textContent).toContain('#design')
    expect(onSaved).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('a meeting chat: the name only, no topic field', async () => {
    fetchMock.mockResolvedValue(json(200, { channel: { id: 'm-1', kind: 'meeting', name: 'Planning', topic: null } }))
    act(() => root.render(h(EditConversationDialog, { channel: { id: 'm-1', kind: 'meeting', name: 'Weekly sync', topic: null }, open: true, onOpenChange: vi.fn(), onSaved: vi.fn() })))
    expect(q('[data-team-chat-edit-topic]')).toBeNull()
    act(() => type(q('[data-team-chat-edit-name]') as HTMLInputElement, 'Planning'))
    await act(async () => q('[data-team-chat-edit-save]')!.click())
    await flush()
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ name: 'Planning' }))
  })
})

describe('DeleteConversationDialog', () => {
  const contents = { messages: 12, files: 2, polls: 1, calls: 1, members: 3, notesKept: 1, liveCall: false, linkCurrent: true, booked: false }

  it('counts what goes and what stays, then deletes', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { contents })).mockResolvedValueOnce(json(200, { deleted: true, filesLeft: 0 }))
    const onDeleted = vi.fn()
    act(() => root.render(h(DeleteConversationDialog, { channel: { id: 'm-1', kind: 'meeting' }, title: 'Weekly sync', open: true, onOpenChange: vi.fn(), onDeleted })))
    expect((q('[data-team-chat-delete-confirm]') as HTMLButtonElement).disabled).toBe(true)
    await flush()
    const text = q('[data-team-chat-delete-dialog]')!.textContent ?? ''
    expect(text).toContain('Weekly sync')
    expect(text).toContain('12 messages, with their threads and reactions')
    expect(text).toContain('2 files')
    expect(text).toContain('The meeting link: it stops working')
    expect(text).toContain('The call’s notes')
    await act(async () => q('[data-team-chat-delete-confirm]')!.click())
    await flush()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/account/team-chat/channels/m-1', { method: 'DELETE' })
    expect(onDeleted).toHaveBeenCalledWith('m-1')
  })

  it('a channel: named with its #, no link line, its name free again', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { contents: { ...contents, linkCurrent: false } }))
    act(() => root.render(h(DeleteConversationDialog, { channel: { id: 'c-1', kind: 'channel' }, title: 'design', open: true, onOpenChange: vi.fn(), onDeleted: vi.fn() })))
    await flush()
    const text = q('[data-team-chat-delete-dialog]')!.textContent ?? ''
    expect(text).toContain('Delete #design for everyone?')
    expect(text).toContain('free to use again')
    expect(text).not.toContain('meeting link')
    expect(q('[data-team-chat-delete-confirm]')!.textContent).toBe('Delete channel')
  })

  it('a live call keeps Delete off and says why', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { contents: { ...contents, liveCall: true } }))
    act(() => root.render(h(DeleteConversationDialog, { channel: { id: 'm-1', kind: 'meeting' }, title: 'Weekly sync', open: true, onOpenChange: vi.fn(), onDeleted: vi.fn() })))
    await flush()
    expect(q('[data-team-chat-delete-live]')).not.toBeNull()
    expect((q('[data-team-chat-delete-confirm]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a booked meeting says its guest’s link stops too; an empty one says so', () => {
    expect(conversationGoes({ ...contents, booked: true })).toContain('The meeting link: it stops working, the booked guest’s too')
    expect(conversationGoes({ ...contents, messages: 0, files: 0, polls: 0, calls: 0, linkCurrent: false })[0]).toBe('Its messages (there are none yet)')
  })
})
