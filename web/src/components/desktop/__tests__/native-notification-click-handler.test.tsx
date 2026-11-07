// @vitest-environment jsdom
/**
 * NativeNotificationClickHandler — cross-workspace routing, and the home thread.
 *
 * The realtime channel that raises native OS banners is per-MEMBER and
 * re-subscribes on a workspace switch, so a banner raised in workspace A can
 * still be sitting in the OS notification center after the user has moved on
 * to workspace B. Clicking it must never open A's item against B's data (an
 * empty panel for an id that doesn't exist there): a foreign notification's
 * card carries A, and the tabs switch into A first and put it in A's chat
 * (P5: every way in opens a card). A workspace the user is no longer a member
 * of has nothing to switch into, so that one stays informational — toast +
 * this workspace's home thread, never a no-op.
 *
 * Every click marks its notification read (the payload's `notification_id`),
 * any banner's, not only a bot's: the agent then knows the person saw it. Where
 * nothing particular opens (no payload, a workspace you left, an unresolvable
 * target) the click opens the home thread (openHomeThread here, or
 * openHrefInWorkspace(ws, '/account') for another workspace's): the inbox card
 * went with the notifications page (docs/plans/retire-notifications-page.md).
 *
 * Driven through a real render (createRoot + act), the house pattern for
 * hooks/effects in this repo — there is no @testing-library/react here. The
 * click handler Rust would invoke is captured off the mocked
 * `tauriBridge.onNotificationClicked` call and then invoked directly per case.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ClickPayload = { id: string; payload: string | null }
type ClickHandler = (e: ClickPayload) => void | Promise<void>

const hoisted = vi.hoisted(() => ({
  openHref: vi.fn(),
  resolveDetailPanel: vi.fn(),
  toast: vi.fn(),
  unlisten: vi.fn(),
  notifyReady: vi.fn(),
  notifyGone: vi.fn(),
  workspaces: [] as Array<{ id: string; name: string }>,
  currentId: null as string | null,
  clickHandler: null as ClickHandler | null,
  /** Where any work item opens (useOpenWorkItem, bots-v4.md Phase 2). */
  openWorkItem: vi.fn(),
  /** This workspace's home thread: where a click opens when nothing particular does. */
  openHomeThread: vi.fn(),
}))

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    onNotificationClicked: (cb: ClickHandler) => {
      hoisted.clickHandler = cb
      return Promise.resolve(hoisted.unlisten)
    },
    notifyNotificationClickListenerReady: () => {
      hoisted.notifyReady()
      return Promise.resolve()
    },
    notifyNotificationClickListenerGone: () => {
      hoisted.notifyGone()
      return Promise.resolve()
    },
  },
}))

vi.mock('@/lib/platform', () => ({
  isDesktopApp: () => true,
}))

vi.mock('@/app/account/open-href-in-workspace', () => ({ openHrefInWorkspace: hoisted.openHref }))
vi.mock('@/lib/chat/home-thread-client', () => ({ openHomeThread: hoisted.openHomeThread }))

vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaces: () => ({ workspaces: hoisted.workspaces, currentId: hoisted.currentId }),
}))

vi.mock('sonner', () => ({
  toast: hoisted.toast,
}))

vi.mock('@/app/account/notification-panel', () => ({
  resolveNotificationDetailPanel: hoisted.resolveDetailPanel,
}))

vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => hoisted.openWorkItem }))

const markAsRead = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/app/account/notification-context', () => ({
  useNotifications: () => ({ markAsRead }),
}))

import { NativeNotificationClickHandler, parseBot } from '../native-notification-click-handler'
import { __resetNoticeFacesForTests, publishNoticeFaces } from '@/lib/bots/notice-faces'
import { BOT_CHARACTERS } from '@/lib/bots/bot-faces'
import { OPEN_CARD_EVENT, type OpenCardRequest } from '@/lib/chat-cards/open-card'

/** Every card the clicks opened (the tabs provider isn't mounted: the requests are the result). */
let opened: OpenCardRequest[] = []
const onOpenCard = (e: Event) => opened.push((e as CustomEvent<OpenCardRequest>).detail)
const ACTION_CARD = { kind: 'record', record: { type: 'action', id: 'act-1' } }

/** Mirrors tryShowNativeNotification's payload (notification-context.tsx).
 *  `overrides` lets a test drop or replace individual fields; pass
 *  `workspace_id: undefined` via omission (not `null`) to simulate a
 *  pre-workspace_id payload from an older binary. */
function buildPayload(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    notification_id: 'notif-1',
    type: 'comment_mention',
    workspace_id: 'ws-1',
    target_type: 'action',
    target_id: 'act-1',
    context_type: null,
    context_id: null,
    metadata: {},
    title: 'Someone mentioned you',
    body: 'Take a look at this',
  }
  return JSON.stringify({ ...base, ...overrides })
}

const DETAIL_PANEL = { type: 'action', id: 'act-1', title: 'Do thing' }

let container: HTMLDivElement
let root: Root

async function mount() {
  act(() => {
    root.render(h(NativeNotificationClickHandler))
  })
  // Flush the onNotificationClicked() promise chain so hoisted.clickHandler
  // (set inside its `.then`) is populated before a test invokes it.
  await act(async () => {})
}

async function click(payload: string) {
  await act(async () => {
    await hoisted.clickHandler!({ id: 'notif-1', payload })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.clickHandler = null
  hoisted.workspaces = [
    { id: 'ws-1', name: 'Acme Inc' },
    { id: 'ws-2', name: 'Beta Co' },
  ]
  hoisted.currentId = 'ws-1'
  hoisted.resolveDetailPanel.mockResolvedValue(DETAIL_PANEL)
  opened = []
  window.addEventListener(OPEN_CARD_EVENT, onOpenCard)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.removeEventListener(OPEN_CARD_EVENT, onOpenCard)
})

describe('NativeNotificationClickHandler — cross-workspace routing', () => {
  it('same workspace: opens the record card, no workspace on it, no toast', async () => {
    await mount()
    await click(buildPayload({ workspace_id: 'ws-1' }))

    expect(hoisted.resolveDetailPanel).toHaveBeenCalledTimes(1)
    expect(hoisted.toast).not.toHaveBeenCalled()
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ from: 'notification', spec: ACTION_CARD })
    expect(opened[0].workspaceId).toBeUndefined()
  })

  it('different workspace (still a member): the card carries that workspace, so it opens there; no toast', async () => {
    await mount()
    await click(buildPayload({ workspace_id: 'ws-2' }))

    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ workspaceId: 'ws-2', spec: ACTION_CARD })
    expect(hoisted.toast).not.toHaveBeenCalled()
  })

  it('different workspace with an unresolvable target: opens that workspace’s home thread (switched to)', async () => {
    hoisted.resolveDetailPanel.mockResolvedValue(null)
    await mount()
    await click(buildPayload({ workspace_id: 'ws-2', target_type: 'cycle' }))

    expect(opened).toHaveLength(0)
    expect(hoisted.openHref).toHaveBeenCalledWith('ws-2', '/account', 'ws-1')
    expect(hoisted.openHomeThread).not.toHaveBeenCalled()
  })

  it('same workspace with an unresolvable target (a digest): opens the home thread here', async () => {
    hoisted.resolveDetailPanel.mockResolvedValue(null)
    await mount()
    await click(buildPayload({ type: 'daily_digest', target_type: null, target_id: null }))

    expect(opened).toHaveLength(0)
    expect(hoisted.openHomeThread).toHaveBeenCalledTimes(1)
    expect(hoisted.openHref).not.toHaveBeenCalled()
    expect(markAsRead).toHaveBeenCalledWith('notif-1')
  })

  it('payload without workspace_id (older shape): behaves as same-workspace, no toast', async () => {
    const { workspace_id: _drop, ...oldShape } = JSON.parse(buildPayload())
    await mount()
    await click(JSON.stringify(oldShape))

    expect(hoisted.toast).not.toHaveBeenCalled()
    expect(hoisted.resolveDetailPanel).toHaveBeenCalledTimes(1)
    expect(opened[0]).toMatchObject({ spec: ACTION_CARD })
    expect(opened[0].workspaceId).toBeUndefined()
  })

  it('foreign workspace id not in the user\'s list (no longer a member): toasts and opens the home thread here', async () => {
    await mount()
    await click(buildPayload({ workspace_id: 'ws-99' }))

    // Nothing to switch INTO, so the panel is never resolved (it could only be
    // resolved against the wrong workspace) and the click stays informational.
    expect(hoisted.resolveDetailPanel).not.toHaveBeenCalled()
    expect(hoisted.toast).toHaveBeenCalledTimes(1)
    expect(hoisted.toast.mock.calls[0][0]).toBe('This notification is from another workspace')
    expect(opened).toHaveLength(0)
    expect(hoisted.openHomeThread).toHaveBeenCalledTimes(1)
    expect(hoisted.openHref).not.toHaveBeenCalled()
    // Clicked is read, even here.
    expect(markAsRead).toHaveBeenCalledWith('notif-1')
  })

  it('null or garbage payload: opens the home thread here, and reads nothing (no id to read)', async () => {
    await mount()
    await click('not json at all')

    expect(hoisted.resolveDetailPanel).not.toHaveBeenCalled()
    expect(opened).toHaveLength(0)
    expect(hoisted.openHomeThread).toHaveBeenCalledTimes(1)
    expect(markAsRead).not.toHaveBeenCalled()
  })
})

describe('NativeNotificationClickHandler — clicked is read', () => {
  it('any banner’s click marks its notification read, a plain notice’s too (not only a bot’s)', async () => {
    await mount()
    await click(buildPayload({ notification_id: 'notif-7' }))
    expect(markAsRead).toHaveBeenCalledTimes(1)
    expect(markAsRead).toHaveBeenCalledWith('notif-7')
    // And what it is about still opens.
    expect(opened[0]).toMatchObject({ spec: ACTION_CARD })
  })

  it('an older payload with no notification id reads nothing, and still opens', async () => {
    const { notification_id: _drop, ...oldShape } = JSON.parse(buildPayload())
    await mount()
    await click(JSON.stringify(oldShape))
    expect(markAsRead).not.toHaveBeenCalled()
    expect(opened[0]).toMatchObject({ spec: ACTION_CARD })
  })
})

describe('NativeNotificationClickHandler — agent_run hard navigation', () => {
  const agentRunPayload = (workspaceId: string | null) =>
    buildPayload({
      workspace_id: workspaceId,
      type: 'work_run_ready',
      target_type: 'agent_run',
      target_id: 'run-7',
      context_type: null,
      context_id: null,
    })

  it('cross-workspace run: the href goes through its workspace, so the cookie is switched BEFORE the page loads', async () => {
    await mount()
    await click(agentRunPayload('ws-2'))

    expect(hoisted.openHref).toHaveBeenCalledTimes(1)
    expect(hoisted.openHref).toHaveBeenCalledWith('ws-2', '/account/agent-runs/run-7', 'ws-1')
    expect(hoisted.resolveDetailPanel).not.toHaveBeenCalled()
    expect(opened).toHaveLength(0)
  })

  it('run with no workspace_id (older payload): routes the href through the CURRENT workspace', async () => {
    await mount()
    await click(agentRunPayload(null))
    expect(hoisted.openHref).toHaveBeenCalledWith('ws-1', '/account/agent-runs/run-7', 'ws-1')
  })
})

/**
 * A banner about a loop run opens the Flows card on that run; one about an
 * email draft opens the Mail card on Drafts; a sprint that started opens its
 * team's board. Every click surface goes through the same shared helper
 * (openNotificationTarget).
 */
describe('NativeNotificationClickHandler — flow, mail and team board targets', () => {
  const FLOW_TARGET = { type: 'flow', id: 'flow-1', title: 'Triage', runId: 'run-9' }
  const MAIL_TARGET = { type: 'mail', id: 'drafts', title: 'Draft ready' }
  const BOARD_TARGET = { type: 'team_board', id: 'team-eng', title: 'Sprint 4 started' }
  const flowPayload = (workspaceId: string) =>
    buildPayload({
      workspace_id: workspaceId,
      type: 'flow_run_output',
      target_type: 'flow_run',
      target_id: 'run-9',
    })

  it('same-workspace flow: the Flows card, editing the flow on the run', async () => {
    hoisted.resolveDetailPanel.mockResolvedValue(FLOW_TARGET)
    await mount()
    await click(flowPayload('ws-1'))
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ spec: { kind: 'flows' }, seed: { editing: 'flow-1', editingRun: 'run-9' } })
    expect(opened[0].workspaceId).toBeUndefined()
    expect(hoisted.toast).not.toHaveBeenCalled()
  })

  it('foreign flow: the same card, in that workspace', async () => {
    hoisted.resolveDetailPanel.mockResolvedValue(FLOW_TARGET)
    await mount()
    await click(flowPayload('ws-2'))
    expect(opened[0]).toMatchObject({ workspaceId: 'ws-2', spec: { kind: 'flows' }, seed: { editing: 'flow-1' } })
  })

  it('mail target: the Mail card on Drafts', async () => {
    hoisted.resolveDetailPanel.mockResolvedValue(MAIL_TARGET)
    await mount()
    await click(buildPayload({ type: 'email_draft_ready', target_type: 'email_draft', target_id: 'd1' }))
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ spec: { kind: 'mail', mail: { folder: 'drafts' } } })
  })

  it('a sprint that started (cycle): its team’s board, in its workspace', async () => {
    hoisted.resolveDetailPanel.mockResolvedValue(BOARD_TARGET)
    await mount()
    await click(buildPayload({ type: 'cycle_started', target_type: 'cycle', target_id: 'cyc-1', metadata: { team_id: 'team-eng' }, workspace_id: 'ws-2' }))
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({
      workspaceId: 'ws-2',
      spec: { kind: 'team_board', target: { type: 'team', id: 'team-eng' } },
    })
    expect(hoisted.openHomeThread).not.toHaveBeenCalled()
  })
})

describe('NativeNotificationClickHandler — a bot’s banner (bots v3 1b)', () => {
  const botPayload = (bot: Record<string, unknown>) =>
    buildPayload({ type: 'flow_run_output', target_type: 'work_item', target_id: 'job-1', bot })

  beforeEach(() => {
    __resetNoticeFacesForTests()
  })

  it('reads the notice and takes the path any notice does, whether or not the window knows its face', async () => {
    publishNoticeFaces([{ id: 'tm-triage', bot_character: BOT_CHARACTERS[0].type }])
    await mount()
    await click(botPayload({ teammate_id: 'tm-triage', face: null, work_item_id: 'job-1' }))
    expect(markAsRead).toHaveBeenCalledWith('notif-1')
    expect(opened).toHaveLength(1)
    await click(botPayload({ teammate_id: 'tm-unknown', face: null }))
    expect(opened).toHaveLength(2)
  })

  it('reads the bot off a payload, or nothing', () => {
    expect(parseBot(botPayload({ teammate_id: 'tm-1', face: 'f', work_item_id: 'job-1' }))).toEqual({
      teammateId: 'tm-1',
      face: 'f',
      workItemId: 'job-1',
    })
    expect(parseBot(buildPayload())).toBeNull()
    expect(parseBot(botPayload({ face: 'f' }))).toBeNull()
    expect(parseBot('{nope')).toBeNull()
    expect(parseBot(null)).toBeNull()
  })
})

/**
 * A banner about a work item (bots-v4.md "An item opens on its bot's page",
 * Phase 2): where any work item opens, through useOpenWorkItem, on its bot's
 * page, else on its own card. A bot's banner names its bot; a plain banner's
 * teammate is the source's (or the lookup's) to say.
 */
describe('NativeNotificationClickHandler — a work item', () => {
  const WORK = { type: 'work_item', id: 'job-1', title: 'Triage: 2 need you' }
  beforeEach(() => {
    __resetNoticeFacesForTests()
    hoisted.openWorkItem.mockReset()
    hoisted.resolveDetailPanel.mockResolvedValue(WORK)
  })

  it('a bot’s banner: the item where any item opens, its bot named', async () => {
    publishNoticeFaces([{ id: 'tm-triage', bot_character: BOT_CHARACTERS[0].type }])
    await mount()
    await click(buildPayload({ type: 'work_needs_you', target_type: 'work_item', target_id: 'job-1', bot: { teammate_id: 'tm-triage', face: null, work_item_id: 'job-1' } }))
    expect(markAsRead).toHaveBeenCalledWith('notif-1')
    expect(hoisted.openWorkItem).toHaveBeenCalledWith('job-1', [], { workspaceId: 'ws-1', title: 'Triage: 2 need you', teammateId: 'tm-triage' })
    expect(opened).toHaveLength(0)
  })

  it('a plain banner about a work item: where any item opens, in its workspace, no teammate named', async () => {
    hoisted.currentId = 'ws-1'
    hoisted.workspaces = [{ id: 'ws-1', name: 'One' }, { id: 'ws-2', name: 'Two' }]
    await mount()
    await click(buildPayload({ type: 'work_failed', target_type: 'work_item', target_id: 'job-1', workspace_id: 'ws-2' }))
    expect(hoisted.openWorkItem).toHaveBeenCalledWith('job-1', [], { workspaceId: 'ws-2', title: 'Triage: 2 need you' })
    expect(opened).toHaveLength(0)
  })
})

describe('NativeNotificationClickHandler — the router’s banner about a home-thread message', () => {
  // PROD 2026-10-31: a click on "your Whole Foods delivery moved" only showed
  // the home thread, which the chat was on already: nothing happened, and the
  // message the open chat had missed stayed missing.
  const WS_A = '33333333-3333-4333-8333-333333333333'
  const WS_B = '44444444-4444-4444-8444-444444444444'
  const HOME = '11111111-1111-4111-8111-111111111111'
  const banner = (overrides: Record<string, unknown> = {}) =>
    buildPayload({
      type: 'agent_message',
      workspace_id: WS_A,
      target_type: null,
      target_id: null,
      metadata: { conversation_id: HOME, home_message_id: '7e70805a-09d3-479d-95d3-71a78e1d3613', message_id: 'home-turn:0e50adb5', messages: 1 },
      ...overrides,
    })

  beforeEach(() => {
    hoisted.workspaces = [
      { id: WS_A, name: 'Acme Inc' },
      { id: WS_B, name: 'Beta Co' },
    ]
    hoisted.currentId = WS_A
    hoisted.resolveDetailPanel.mockResolvedValue(null)
  })

  it('opens the home thread on its message, and reads it', async () => {
    await mount()
    await click(banner())

    expect(hoisted.openHomeThread).toHaveBeenCalledWith({ reveal: { messageId: 'home-turn:0e50adb5' } })
    expect(markAsRead).toHaveBeenCalledWith('notif-1')
    expect(hoisted.openHref).not.toHaveBeenCalled()
  })

  it('a banner from before it carried the message id still reads the thread’s newest rows in', async () => {
    await mount()
    await click(banner({ metadata: { conversation_id: HOME, home_message_id: '7e70805a-09d3-479d-95d3-71a78e1d3613', messages: 1 } }))

    expect(hoisted.openHomeThread).toHaveBeenCalledWith({ reveal: { messageId: null } })
  })

  it('another workspace’s: switched to, where the home thread loads afresh', async () => {
    await mount()
    await click(banner({ workspace_id: WS_B }))

    expect(hoisted.openHref).toHaveBeenCalledWith(WS_B, '/account', WS_A)
    expect(hoisted.openHomeThread).not.toHaveBeenCalled()
  })

  it('any other untargeted notice opens the home thread as before, on no message', async () => {
    await mount()
    await click(buildPayload({ type: 'agent_digest', workspace_id: WS_A, target_type: null, target_id: null, metadata: { conversation_id: HOME } }))

    expect(hoisted.openHomeThread).toHaveBeenCalledWith({})
  })
})
