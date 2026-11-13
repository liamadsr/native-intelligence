// @vitest-environment jsdom
/**
 * `openNotificationTarget` — the routing every notification click surface
 * (the bell's inbox card, the desktop's native banner, the work item panel's
 * links) shares. Every way in opens a card (P5): a flow opens its Flows card
 * on the run, mail the Mail card on the folder, a sequence its Sequences
 * card, a record its record card, a work item / feedback request the inbox
 * card's overlay — all with the notification's workspace when it is another.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { notificationCardTarget, openNotificationTarget } from '../notification-open'
import { OPEN_CARD_EVENT, type OpenCardRequest } from '@/lib/chat-cards/open-card'

let opened: OpenCardRequest[] = []
const onOpen = (e: Event) => opened.push((e as CustomEvent<OpenCardRequest>).detail)

beforeEach(() => {
  opened = []
  window.addEventListener(OPEN_CARD_EVENT, onOpen)
})
afterEach(() => window.removeEventListener(OPEN_CARD_EVENT, onOpen))

describe('openNotificationTarget', () => {
  it('a flow: the Flows card on the run, same workspace', () => {
    expect(openNotificationTarget({ type: 'flow', id: 'flow-1', title: 'Nightly', runId: 'run-9' }, { foreignWorkspaceId: null })).toBe(true)
    expect(opened).toHaveLength(1)
    expect(opened[0].from).toBe('notification')
    expect(opened[0].workspaceId).toBeUndefined()
    expect(notificationCardTarget({ type: 'flow', id: 'flow-1', title: 'Nightly', runId: 'run-9' })).toMatchObject({ type: 'flow', id: 'flow-1', runId: 'run-9' })
  })

  it('another workspace: the request carries it, so the tabs switch first', () => {
    openNotificationTarget({ type: 'action', id: 'act-1', title: 'GEN-1' }, { foreignWorkspaceId: 'ws-2' })
    expect(opened[0]).toMatchObject({ workspaceId: 'ws-2', spec: { kind: 'record', record: { type: 'action', id: 'act-1' } } })
  })

  it('mail: the Mail card on the folder', () => {
    openNotificationTarget({ type: 'mail', id: 'drafts', title: 'Drafts' }, { foreignWorkspaceId: null })
    expect(opened[0].spec).toMatchObject({ kind: 'mail', mail: { folder: 'drafts' } })
    openNotificationTarget({ type: 'mail', id: 'scheduled', title: 'A scheduled email wasn’t sent' }, { foreignWorkspaceId: null })
    expect(opened[1].spec).toMatchObject({ kind: 'mail', mail: { folder: 'scheduled' } })
  })

  it('a sequence: its Sequences card', () => {
    openNotificationTarget({ type: 'sequence', id: 'seq-1', title: 'Outreach paused' }, { foreignWorkspaceId: null })
    expect(opened[0].spec).toMatchObject({ kind: 'sequences', target: { type: 'sequence', id: 'seq-1' } })
  })

  it('a work item: its target (the inbox card draws it)', () => {
    expect(notificationCardTarget({ type: 'work_item', id: 'wi-1', title: 'Draft' })).toEqual({ type: 'work_item', id: 'wi-1', title: 'Draft' })
  })
})
