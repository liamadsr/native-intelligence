import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
const desktop = vi.fn(() => true)
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => desktop() }))

import { openCallWindow, parseCallWindowBegin, parseCallWindowState, showCallWindow, takeCallWindowCall, viewOfBegin, type CallWindowBegin } from '../call-window'

const NOTES = { notes: false, notes_by: null, notes_state: 'off', capture_id: null, recording: 'off', recording_by: null }
const FEATURES = { notes: true, recording: false, liveNotes: false }

function begin(over: Partial<CallWindowBegin> = {}): CallWindowBegin {
  return {
    call: { id: 'call-1', channelId: 'chan-1', workspaceId: 'ws-1', messageId: null, channelKind: 'meeting', memberId: 'mem-1', features: FEATURES, notes: NOTES } as CallWindowBegin['call'],
    join: { url: 'wss://calls.example.test', token: 'tok', room: 'room-1', callId: 'call-1' },
    label: 'Weekly sync',
    workspaceId: 'ws-1',
    ...over,
  }
}

beforeEach(() => {
  invoke.mockReset()
  desktop.mockReturnValue(true)
})

describe('a call handed to the call window', () => {
  it('is read back as it was handed, fresh or not', () => {
    expect(parseCallWindowBegin({ call: begin(), fresh: true })).toEqual({ begin: begin(), fresh: true })
    expect(parseCallWindowBegin({ call: begin({ workspaceId: null }), fresh: false })).toEqual({ begin: begin({ workspaceId: null }), fresh: false })
  })

  it('is refused when it is not a whole call', () => {
    expect(parseCallWindowBegin(null)).toBeNull()
    expect(parseCallWindowBegin({ call: 'call-1' })).toBeNull()
    expect(parseCallWindowBegin({ call: { ...begin(), label: '' } })).toBeNull()
    expect(parseCallWindowBegin({ call: { ...begin(), join: { ...begin().join, token: '' } } })).toBeNull()
    // A token for another call than the one named.
    expect(parseCallWindowBegin({ call: { ...begin(), join: { ...begin().join, callId: 'call-2' } } })).toBeNull()
    expect(parseCallWindowBegin({ call: { ...begin(), call: { ...begin().call, channelKind: 'huddle' } } })).toBeNull()
  })

  it('shows in the app at once, without a connection or its token', () => {
    const view = viewOfBegin(begin())
    expect(view).toEqual({ callId: 'call-1', channelId: 'chan-1', workspaceId: 'ws-1', channelKind: 'meeting', label: 'Weekly sync', memberId: 'mem-1', features: FEATURES, notes: NOTES, guests: [] })
    expect(JSON.stringify(view)).not.toContain('tok')
  })
})

describe("the call window's state, as the app hears it", () => {
  it('is a call, or none with why', () => {
    const view = viewOfBegin(begin())
    expect(parseCallWindowState({ call: view })).toEqual({ call: view })
    expect(parseCallWindowState({ call: { ...view, guests: undefined } })).toEqual({ call: view })
    expect(parseCallWindowState({ call: null, ended: 'removed' })).toEqual({ call: null, ended: 'removed' })
    expect(parseCallWindowState({ call: null })).toEqual({ call: null, ended: undefined })
  })

  it('is ignored when it is not one', () => {
    expect(parseCallWindowState(undefined)).toBeNull()
    expect(parseCallWindowState({})).toBeNull()
    expect(parseCallWindowState({ call: { callId: 'call-1' } })).toBeNull()
  })
})

describe('asking the desktop', () => {
  it('hands the call over', async () => {
    invoke.mockResolvedValue('created')
    expect(await openCallWindow(begin())).toBe('opened')
    expect(invoke).toHaveBeenCalledWith('open_call_window', { call: begin() })
  })

  it('says a build from before the window is missing it, and any other refusal failed', async () => {
    invoke.mockRejectedValueOnce('Command open_call_window not found')
    expect(await openCallWindow(begin())).toBe('missing')
    invoke.mockRejectedValueOnce(new Error('Command open_call_window not allowed by ACL'))
    expect(await openCallWindow(begin())).toBe('missing')
    invoke.mockRejectedValueOnce("couldn't make the call window: no display")
    expect(await openCallWindow(begin())).toBe('failed')
  })

  it('is never asked in a browser', async () => {
    desktop.mockReturnValue(false)
    expect(await openCallWindow(begin())).toBe('missing')
    expect(invoke).not.toHaveBeenCalled()
  })

  it("gives the call window's page its call, or nothing", async () => {
    invoke.mockResolvedValueOnce({ call: begin(), fresh: false })
    expect(await takeCallWindowCall()).toEqual({ begin: begin(), fresh: false })
    invoke.mockResolvedValueOnce(null)
    expect(await takeCallWindowCall()).toBeNull()
    invoke.mockRejectedValueOnce('Only the call window takes a call')
    expect(await takeCallWindowCall()).toBeNull()
  })

  it('says whether there was a window to bring forward', async () => {
    invoke.mockResolvedValueOnce(true)
    expect(await showCallWindow()).toBe(true)
    invoke.mockRejectedValueOnce('Command show_call_window not found')
    expect(await showCallWindow()).toBe(false)
  })
})
