// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { CallSnapshot, TeamCallSession } from '@/lib/team-calls/call-session'
import type { HostedTeamCall } from '../team-calls-provider'
import { CallPanel } from '../call-panel'

const { setRecording } = vi.hoisted(() => ({ setRecording: vi.fn(async () => {}) }))
vi.mock('../team-calls-provider', () => ({ useTeamCalls: () => ({ setRecording }) }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => null }))

it('waits for recording consent and lets the caller stop directly', async () => {
  const snap: CallSnapshot = {
    phase: 'connected', error: null, ended: null, tiles: [], people: 2,
    mic: 'on', camera: 'off', screen: 'off', canShareScreen: false, canPickSpeaker: false,
    needsAudioStart: false, micHeld: false, canPublish: true,
    screenBlocked: false, screenRefused: false, screenDropped: false,
    devices: { audioinput: [], audiooutput: [], videoinput: [] }, active: {},
  }
  const session = {
    subscribe: () => () => {},
    getSnapshot: () => snap,
  } as unknown as TeamCallSession
  const call: HostedTeamCall = {
    callId: 'call', channelId: 'channel', workspaceId: 'workspace',
    channelKind: 'dm', label: 'Rosa', memberId: 'member', session, guests: [],
    features: { notes: false, recording: true },
    notes: { notes: false, notes_by: null, notes_state: 'none', capture_id: null, recording: 'off', recording_by: null },
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const render = (recording: HostedTeamCall['notes']['recording']) =>
    act(() => root.render(
      <CallPanel call={{ ...call, notes: { ...call.notes, recording } }} minimized={false} onMinimize={() => {}} onLeave={() => {}} />,
    ))
  const recordButton = () => document.querySelector<HTMLButtonElement>('[data-team-call-record]')!
  const dialog = () => document.querySelector('[role="alertdialog"]')
  const click = (button: HTMLButtonElement) => act(async () => button.click())
  const dialogButton = (label: string) =>
    Array.from(dialog()!.querySelectorAll('button')).find((button) => button.textContent === label)!

  try {
    render('off')
    await click(recordButton())
    expect(dialog()?.textContent).toContain('Is it okay for me to record the call?')
    expect(setRecording).not.toHaveBeenCalled()

    await click(dialogButton('Cancel'))
    expect(dialog()).toBeNull()
    expect(setRecording).not.toHaveBeenCalled()

    await click(recordButton())
    await click(dialogButton('Everyone agreed · Start recording'))
    expect(setRecording).toHaveBeenCalledExactlyOnceWith('start')

    render('on')
    await click(recordButton())
    expect(dialog()).toBeNull()
    expect(setRecording.mock.calls).toEqual([['start'], ['stop']])
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
