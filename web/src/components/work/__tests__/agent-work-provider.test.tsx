// @vitest-environment jsdom
/**
 * AgentWorkProvider (bot-characters.md Step 3, item 3): one shared source for
 * the bots, mounted once in the shell.
 *
 *   • at boot it loads the light answer once, when the browser goes idle, on
 *     one ledger channel, plus the attention cards on a channel name unique to
 *     the mount (two mounts never share one); nothing ever asks the route for
 *     anything but the light answer (the Agents page and its full answer are
 *     gone, bots-v4 Phase 7b);
 *   • everyone reads the same thing: the cards and the bots' counts, which
 *     include the pending cards;
 *   • the ledger channel is handed on (useOnWorkRow) to readers that keep rows
 *     of their own, a bot's work: the work's own onWorkRow, the same function
 *     for the shell's life, and only inside the provider;
 *   • an unread failed run's notice (the window's botNotices) is new for its
 *     bot until it's read (bots-v4 Phase 4c).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act, createElement as h, useEffect } from 'react'
import type { WorkItem } from '@/lib/work/types'
import type { AgentWork, WorkRowListener } from '@/hooks/use-agent-work'
import { botOwners } from '@/lib/work/bot-owner'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  channelNames: [] as string[],
  removeChannel: vi.fn(),
  /** The bots' notices the window holds (NotificationProvider). */
  botNotices: [] as unknown[],
}))
vi.mock('@/app/account/notification-context', () => ({ useNotifications: () => ({ botNotices: hoisted.botNotices }) }))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/sounds/triggers', () => ({ announceAttentionItem: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (name: string) => {
      hoisted.channelNames.push(name)
      const ch: Record<string, unknown> = {}
      ch.on = () => ch
      // Up a tick later, as the real socket's reply is.
      ch.subscribe = (cb?: (status: string) => void) => {
        void Promise.resolve().then(() => cb?.('SUBSCRIBED'))
        return ch
      }
      return ch
    },
    removeChannel: hoisted.removeChannel,
  }),
}))

import { AGENT_WORK_LIGHT_URL, AGENT_WORK_URL } from '@/hooks/use-agent-work'
import {
  AgentWorkProvider,
  useAgentWorkShared,
  useOnWorkRow,
  useOwnedWork,
  useSharedAttention,
  type AgentWorkShared,
} from '../agent-work-provider'

const ATTENTION_URL = '/api/account/attention-items'

function row(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    title: `Item ${id}`,
    status: 'running',
    actor: 'agent',
    current_step: null,
    progress: {},
    result_summary: null,
    error_message: null,
    skip_reason: null,
    deliverables: [],
    needs: null,
    source: {},
    run_key: null,
    agent_run_id: null,
    flow_run_id: null,
    created_at: '2026-09-27T08:00:00.000Z',
    started_at: null,
    finished_at: null,
    reviewed_at: null,
    last_beat_at: '2026-09-27T08:00:00.000Z',
    deadline_at: null,
    ...over,
  }
}

// The writer has a draft waiting (a work run) and a review you've opened
// already, which must not make its bot move; triage's settled verdict run
// wrote one pending card.
const FEED = [
  row('draft', { status: 'needs_review', ai_team_member_id: 'writer' }),
  row('pass', { kind: 'email_drafts', status: 'needs_review', ai_team_member_id: 'writer', opened_at: '2026-09-27T09:30:00.000Z' }),
  row('coding', { status: 'running', ai_team_member_id: 'writer' }),
  row('verdict', { kind: 'flow_run', status: 'done', ai_team_member_id: 'triage', flow_run_id: 'fr1' }),
]
const CARDS = [
  // A post draft: For you's one kind of card (P13), so the bots count it.
  { id: 'card-1', workspace_id: 'w1', member_id: 'm1', kind: 'question', title: 'File it', why: null, payload: { post_draft: { text: 'We shipped SSO.', surface: 'x' } }, proposal_id: null, source_flow_run_id: 'fr1', status: 'pending', expires_at: null, created_at: '2026-09-27T09:00:00.000Z' },
]

let fetchMock: ReturnType<typeof vi.fn>
let idleCallbacks: Array<() => void>
const roots: Root[] = []
const seen: { bots: AgentWorkShared | null; cards: string[] | null } = { bots: null, cards: null }

function Bots() {
  const shared = useAgentWorkShared()
  useEffect(() => {
    seen.bots = shared
  })
  return null
}
function Cards() {
  const attention = useSharedAttention()
  useEffect(() => {
    seen.cards = attention.items.map((c) => c.id)
  })
  return null
}

function tree() {
  return h(AgentWorkProvider, null, [h(Cards, { key: 'cards' }), h(Bots, { key: 'bots' })])
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function mount(): Promise<Root> {
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => root.render(tree()))
  await flush()
  return root
}

async function goIdle() {
  await act(async () => {
    for (const cb of idleCallbacks.splice(0)) cb()
  })
  await flush()
}

const calls = (url: string) => fetchMock.mock.calls.filter(([u]) => u === url).length
/** The counts that say something (an owner with only settled rows counts all zeros). */
const nonZero = (counts: AgentWorkShared['counts']) =>
  Object.fromEntries([...counts].filter(([, c]) => c.running > 0 || c.needsYou > 0 || c.beckoning.length > 0))
const agentWorkChannels = () => hoisted.channelNames.filter((n) => /^agent-work-\d+$/.test(n))
const attentionChannels = () => hoisted.channelNames.filter((n) => n.startsWith('attention-rail'))

beforeEach(() => {
  hoisted.channelNames = []
  seen.bots = null
  seen.cards = null
  idleCallbacks = []
  ;(window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (cb: () => void) => {
    idleCallbacks.push(cb)
    return idleCallbacks.length
  }
  ;(window as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = () => {}
  fetchMock = vi.fn(async (url: string) => {
    if (url === AGENT_WORK_LIGHT_URL) {
      // Open rows only; the verdict run's row comes as a card row.
      const open = FEED.filter((r) => r.status !== 'done')
      const cardRows = FEED.filter((r) => r.flow_run_id === 'fr1')
      return new Response(JSON.stringify({ light: true, items: open, card_rows: cardRows, roster: [], workspace_ids: ['w1'], current_workspace_id: 'w1' }), { status: 200 })
    }
    if (url === ATTENTION_URL) return new Response(JSON.stringify({ items: CARDS }), { status: 200 })
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback
  delete (window as unknown as { cancelIdleCallback?: unknown }).cancelIdleCallback
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('AgentWorkProvider', () => {
  it('hands the ledger channel on through useOnWorkRow: the work’s own subscribe, the same for the shell’s life, and only inside it', async () => {
    const subscribes: unknown[] = []
    function Reader() {
      const onWorkRow = useOnWorkRow()
      const { work } = useAgentWorkShared()
      useEffect(() => {
        subscribes.push(onWorkRow)
        expect(onWorkRow).toBe(work.onWorkRow)
      })
      return null
    }
    const root = createRoot(document.createElement('div'))
    roots.push(root)
    await act(async () => root.render(h(AgentWorkProvider, null, h(Reader))))
    await goIdle()
    expect(subscribes.length).toBeGreaterThan(1)
    expect(new Set(subscribes).size).toBe(1)

    expect(() => renderToString(h(() => (useOnWorkRow(), null)))).toThrow(/inside AgentWorkProvider/)
  })

  it('loads the light answer once, when the browser goes idle after boot, and the cards once', async () => {
    await mount()
    expect(calls(AGENT_WORK_LIGHT_URL)).toBe(0)
    expect(calls(AGENT_WORK_URL)).toBe(0)
    expect(agentWorkChannels()).toEqual([])
    // The cards load at once.
    expect(calls(ATTENTION_URL)).toBe(1)
    await goIdle()
    expect(calls(AGENT_WORK_LIGHT_URL)).toBe(1)
    expect(calls(AGENT_WORK_URL)).toBe(0)
    expect(calls(ATTENTION_URL)).toBe(1)
    expect(agentWorkChannels()).toHaveLength(1)
    expect(attentionChannels()).toHaveLength(1)
    expect(seen.bots?.work.rows?.map((r) => r.id)).toEqual(['draft', 'pass', 'coding'])
    // Nothing else is ever asked of the route.
    expect(fetchMock.mock.calls.map(([u]) => u).filter((u) => String(u).startsWith(AGENT_WORK_URL) && u !== AGENT_WORK_LIGHT_URL)).toEqual([])
  })

  it('gives each mount its own attention channel name', async () => {
    await mount()
    await mount()
    const names = attentionChannels()
    expect(names).toHaveLength(2)
    expect(names[0]).not.toBe(names[1])
  })

  it('the bots’ counts include the pending cards, and a row you opened waits without beckoning', async () => {
    await mount()
    await goIdle()
    const counts = seen.bots!.counts
    expect(counts.get('tm:writer')).toEqual({ running: 1, needsYou: 2, beckoning: ['draft'] })
    // Triage's run settled; its card is what waits (found through the card rows).
    expect(counts.get('tm:triage')).toEqual({ running: 0, needsYou: 1, beckoning: ['card-1'] })
    expect(seen.cards).toEqual(['card-1'])
  })

  it('an unread failed run’s notice is new for its bot until it’s read (bots-v4 Phase 4c)', async () => {
    const notice = {
      id: 'n-failed',
      type: 'work_failed',
      is_read: false,
      is_archived: false,
      metadata: { teammate_id: 'triage', sentence: 'I couldn’t finish.', work_item_id: 'job-failed' },
      target_type: 'work_item',
      target_id: 'job-failed',
    }
    hoisted.botNotices = [notice]
    try {
      const root = await mount()
      await goIdle()
      expect(seen.bots!.counts.get('tm:triage')).toEqual({ running: 0, needsYou: 1, beckoning: ['card-1', 'failed:job-failed'] })
      // Read (its item opened anywhere): the dot's reason goes.
      hoisted.botNotices = [{ ...notice, is_read: true }]
      await act(async () => root.render(tree()))
      await flush()
      expect(seen.bots!.counts.get('tm:triage')).toEqual({ running: 0, needsYou: 1, beckoning: ['card-1'] })
    } finally {
      hoisted.botNotices = []
    }
  })

  it('a row you opened (migration 295) still waits but no longer beckons', async () => {
    const draft = FEED[0]
    FEED[0] = { ...draft, opened_at: '2026-09-30T12:00:00.000Z' }
    try {
      await mount()
      await goIdle()
      expect(seen.bots!.counts.get('tm:writer')).toEqual({ running: 1, needsYou: 2, beckoning: [] })
    } finally {
      FEED[0] = draft
    }
  })

  it('is read inside the shell only', () => {
    const root = createRoot(document.createElement('div'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => act(() => root.render(h(Bots)))).toThrow(/AgentWorkProvider/)
    spy.mockRestore()
  })
})

// Liam, 2026-10-08: work with no bot you can see is the workspace's Assistant's
// (lib/work/bot-owner.ts), applied once here for every reader of the source.
describe('AgentWorkProvider: work no reachable bot holds is the Assistant’s', () => {
  const ROSTER = [
    { id: 'tm-assistant', workspace_id: 'w1', name: 'Assistant', is_system: true, system_key: 'assistant', bot_character: 'chat', reachable: true },
    { id: 'writer', workspace_id: 'w1', name: 'Writer', is_system: false, system_key: null, bot_character: 'writer', reachable: true },
  ]
  const ROWS = [
    // An older row written before its writer named a bot, and a deleted bot's (the column is `on delete set null`).
    row('legacy', { kind: 'prospecting', status: 'needs_input', ai_team_member_id: null }),
    row('orphaned', { kind: 'crm_import', status: 'running', ai_team_member_id: null }),
    row('draft', { status: 'needs_review', ai_team_member_id: 'writer' }),
    // Sequence sends keep no bot.
    row('send', { kind: 'sequence_enrolment', status: 'running', ai_team_member_id: null }),
  ]
  const CARD_GONE = { ...CARDS[0], id: 'card-gone', source_flow_run_id: null, payload: { raised_by_ai_member_id: 'tm-deleted', post_draft: { text: 'We shipped SSO.', surface: 'x' } } }

  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === AGENT_WORK_LIGHT_URL) {
        return new Response(JSON.stringify({ light: true, items: ROWS, card_rows: [], roster: ROSTER, workspace_ids: ['w1'], current_workspace_id: 'w1' }), { status: 200 })
      }
      if (url === ATTENTION_URL) return new Response(JSON.stringify({ items: [CARD_GONE] }), { status: 200 })
      return new Response('{}', { status: 404 })
    })
  })

  it('counts a teammate-less row, a deleted bot’s row and a card whose raiser is gone for the Assistant; a sequence send stays a lane', async () => {
    await mount()
    await goIdle()
    expect(nonZero(seen.bots!.counts)).toEqual({
      'tm:tm-assistant': { running: 1, needsYou: 2, beckoning: ['legacy', 'card-gone'], asking: ['legacy'] },
      'tm:writer': { running: 0, needsYou: 1, beckoning: ['draft'] },
      'lane:sequence_enrolment': { running: 1, needsYou: 0, beckoning: [] },
    })
    // Every reader holds them named for it: the rows, and the card the rail and the bubble read.
    const held = new Map((seen.bots!.work.rows ?? []).map((r) => [r.id, r]))
    expect(held.get('legacy')).toMatchObject({ ai_team_member_id: 'tm-assistant', teammate: { name: 'Assistant' }, source: { teammate_routed: true } })
    expect(held.get('send')?.ai_team_member_id ?? null).toBeNull()
    expect(seen.bots!.attention.items[0].payload.raised_by_ai_member_id).toBe('tm-assistant')
  })

  it('hands each pushed row on named the same way (useOnWorkRow), so a bot’s page hears it as its own', async () => {
    let push: WorkRowListener | null = null
    const work = { rows: [], cardRows: [], roster: ROSTER, onWorkRow: (l: WorkRowListener) => ((push = l), () => {}) } as unknown as AgentWork
    const owners = botOwners(ROSTER, { complete: true })
    const heard: Array<WorkItem> = []
    function Probe() {
      const { onWorkRow } = useOwnedWork(work, owners)
      useEffect(() => onWorkRow((e) => void (e.type === 'row' && heard.push(e.row))), [onWorkRow])
      return null
    }
    const root = createRoot(document.createElement('div'))
    roots.push(root)
    await act(async () => root.render(h(Probe)))
    await act(async () => push!({ type: 'row', row: row('pushed', { kind: 'email_import', ai_team_member_id: null }) }))
    await act(async () => push!({ type: 'row', row: row('mine', { ai_team_member_id: 'writer' }) }))
    expect(heard.map((r) => [r.id, r.ai_team_member_id])).toEqual([
      ['pushed', 'tm-assistant'],
      ['mine', 'writer'],
    ])
  })

  it('with no Assistant in the roster, keeps today’s answer: the lanes and a card that names no one count as they did', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === AGENT_WORK_LIGHT_URL) {
        return new Response(JSON.stringify({ light: true, items: ROWS, card_rows: [], roster: ROSTER.slice(1), workspace_ids: ['w1'], current_workspace_id: 'w1' }), { status: 200 })
      }
      if (url === ATTENTION_URL) return new Response(JSON.stringify({ items: [CARD_GONE] }), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    await mount()
    await goIdle()
    expect(nonZero(seen.bots!.counts)).toEqual({
      'lane:prospecting': { running: 0, needsYou: 1, beckoning: ['legacy'], asking: ['legacy'] },
      'lane:crm_import': { running: 1, needsYou: 0, beckoning: [] },
      'tm:writer': { running: 0, needsYou: 1, beckoning: ['draft'] },
      'tm:tm-deleted': { running: 0, needsYou: 1, beckoning: ['card-gone'] },
      'lane:sequence_enrolment': { running: 1, needsYou: 0, beckoning: [] },
    })
  })
})
