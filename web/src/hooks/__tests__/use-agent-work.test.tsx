// @vitest-environment jsdom
/**
 * useAgentWork: what the bots show, the light read (the Agents page and its
 * full answer are gone, bots-v4 Phase 7b).
 *
 *   • loads GET /api/account/agent-work?light=1, and nothing else from the
 *     route, on a channel name of its own, unique per mount (supabase-js
 *     returns the same channel object for a repeated topic); no `work_touch`
 *     channel;
 *   • admits a pushed row by WORKSPACE (one the route answered for), not by
 *     member, so a widened SELECT policy would need no change here;
 *   • refetches on a push only for a dismissed attempt (the light read
 *     carries the breakers), never to name a teammate;
 *   • Reviewed / Dismiss settle optimistically and restore on failure;
 *   • Stop posts the row's cancel route with the ROW'S workspace header, and
 *     the row stays "stopping" until it leaves the live statuses;
 *   • `enabled: false` loads nothing and subscribes nothing; a done row the
 *     answer carries (bots-v4 Phase 4b) is held with what it made, so its
 *     "done" peek survives a reload;
 *   • `aiLimited` is the answer's `ai_limited`, moved on by the rows pushed
 *     since it was read (a run the limit stopped stops its teammate, a later
 *     run wakes one), and the same map while who and when don't change;
 *   • a load waits for the ledger channel to be up, but realtime being slow
 *     never holds the data back;
 *   • a failed load retries by itself (2 s, 8 s, 30 s, then every 2 minutes)
 *     and when the window comes back into focus; signed out (401 twice), only
 *     the long interval; never after unmount;
 *   • a teammate changed in this window or another of the app's (the
 *     teammates-changed event, or its storage ping) reloads the roster.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'
import type { WorkItem } from '@/lib/work/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, Map<string, (p: { new: unknown }) => void>>(),
  channelNames: [] as string[],
  /** Each channel's subscribe callback. */
  subscribers: new Map<string, (status: string) => void>(),
  /** Channels that are up (SUBSCRIBED) and not removed: what a table write reaches. */
  up: new Set<string>(),
  /** While true, a channel made now stays down until the test brings it up. */
  holdSubscribe: false,
  removeChannel: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

vi.mock('sonner', () => ({ toast: hoisted.toast }))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (name: string) => {
      hoisted.channelNames.push(name)
      const byEvent = new Map<string, (p: { new: unknown }) => void>()
      hoisted.handlers.set(name, byEvent)
      const ch: Record<string, unknown> = { topic: name }
      ch.on = (_type: string, spec: { event: string; table?: string }, cb: (p: { new: unknown }) => void) => {
        // The ledger's handlers by event; any other table's as `table:event`.
        byEvent.set(!spec.table || spec.table === 'tracked_job' ? spec.event : `${spec.table}:${spec.event}`, cb)
        return ch
      }
      // Up a tick later, as the real socket's reply is, unless held.
      ch.subscribe = (cb?: (status: string) => void) => {
        hoisted.subscribers.set(name, cb ?? (() => {}))
        if (!hoisted.holdSubscribe) {
          void Promise.resolve().then(() => {
            hoisted.up.add(name)
            hoisted.subscribers.get(name)!('SUBSCRIBED')
          })
        }
        return ch
      }
      return ch
    },
    removeChannel: (ch: { topic: string }) => {
      hoisted.up.delete(ch.topic)
      hoisted.subscribers.delete(ch.topic)
      hoisted.removeChannel(ch)
    },
  }),
}))

import {
  AGENT_AUTONOMY_RESUME_URL,
  AGENT_WORK_LIGHT_URL,
  AGENT_WORK_URL,
  SUBSCRIBE_WAIT_MS,
  AI_LIMIT_AGE_MS,
  useAgentWork,
  type AgentWork,
} from '../use-agent-work'

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

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
let listed: WorkItem[]
let respond: (url: string, init?: RequestInit) => Response | null
const holder: { api: AgentWork | null } = { api: null }

/** Whether the probe's hook is enabled (the test drives it). */
const probe = { enabled: true }
function Probe() {
  const api = useAgentWork({ enabled: probe.enabled })
  useEffect(() => {
    holder.api = api
  }, [api])
  return null
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function mount(enabled = true) {
  probe.enabled = enabled
  await act(async () => root.render(h(Probe)))
  await flush()
}

/** The ledger channels (`agent-work-<n>`), oldest first. */
const ledgerChannels = () => hoisted.channelNames.filter((n) => /^agent-work-\d+$/.test(n))

async function push(event: 'INSERT' | 'UPDATE', r: WorkItem, channel = ledgerChannels().at(-1)!) {
  await act(async () => {
    hoisted.handlers.get(channel)!.get(event)!({ new: r })
    await Promise.resolve()
  })
}

/** Brings every channel still down up. */
async function bringUp() {
  hoisted.holdSubscribe = false
  await act(async () => {
    for (const [name, cb] of hoisted.subscribers) {
      if (hoisted.up.has(name)) continue
      hoisted.up.add(name)
      cb('SUBSCRIBED')
    }
  })
  await flush()
}

const ids = () => (holder.api?.rows ?? []).map((it) => it.id)
const rowOf = (id: string) => (holder.api?.rows ?? []).find((it) => it.id === id) as WorkItem | undefined
const lightFetches = () => fetchMock.mock.calls.filter(([url]) => url === AGENT_WORK_LIGHT_URL).length
/** Anything else asked of the route (nothing should be). */
const otherRouteFetches = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith(AGENT_WORK_URL) && url !== AGENT_WORK_LIGHT_URL).length

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  holder.api = null
  probe.enabled = true
  hoisted.channelNames = []
  hoisted.handlers.clear()
  hoisted.subscribers.clear()
  hoisted.up.clear()
  hoisted.holdSubscribe = false
  listed = [row('live'), row('review', { status: 'needs_review', needs: { kind: 'review', verb: 'review' } })]
  respond = () => null
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = respond(url, init)
    if (custom) return custom
    if (url === AGENT_WORK_LIGHT_URL) {
      return new Response(
        JSON.stringify({
          light: true,
          items: listed.filter((it) => it.status !== 'done').map(({ id, workspace_id, member_id, kind, status, flow_run_id, source, created_at }) => ({ id, workspace_id, member_id, kind, status, flow_run_id, source, created_at })),
          card_rows: [{ id: 'loop', workspace_id: 'w1', member_id: 'm1', kind: 'flow_run', status: 'done', flow_run_id: 'fr1', ai_team_member_id: 'triage', source: {}, created_at: '2026-09-26T08:00:00.000Z' }],
          roster: [{ id: 'tm1', name: 'Writer', breaker: null }],
          workspace_ids: ['w1', 'w2'],
          current_workspace_id: 'w1',
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('useAgentWork', () => {
  it('loads the light answer and roster on a channel name unique to the mount, and asks the route for nothing else', async () => {
    await mount()
    expect(lightFetches()).toBe(1)
    expect(otherRouteFetches()).toBe(0)
    expect(ids()).toEqual(['live', 'review'])
    expect(holder.api?.roster).toEqual([{ id: 'tm1', name: 'Writer', breaker: null }])
    expect(holder.api?.workspaceIds).toEqual(['w1', 'w2'])
    expect(holder.api?.currentWorkspaceId).toBe('w1')
    const second = createRoot(document.createElement('div'))
    await act(async () => second.render(h(() => (useAgentWork(), null))))
    expect(ledgerChannels()).toHaveLength(2)
    expect(ledgerChannels()[0]).not.toBe(ledgerChannels()[1])
    act(() => second.unmount())
  })

  it('admits a pushed row by workspace, whoever owns it, and ignores other workspaces', async () => {
    await mount()
    await push('INSERT', row('teammates', { workspace_id: 'w2', member_id: 'someone-else', created_at: '2026-09-27T09:00:00.000Z' }))
    await push('INSERT', row('elsewhere', { workspace_id: 'w3' }))
    await push('UPDATE', row('live', { status: 'done' }))
    // 'live' and 'review' share a created_at; only membership and the newest row's place are asserted.
    expect(ids()[0]).toBe('teammates')
    expect([...ids()].sort()).toEqual(['live', 'review', 'teammates'])
    expect(rowOf('live')?.status).toBe('done')
  })

  it('hands every row its channel delivers to onWorkRow listeners (any workspace), and resync each time the channel comes up; a listener that throws stops nothing', async () => {
    await mount()
    const onWorkRow = holder.api!.onWorkRow
    const heard: unknown[] = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let off!: () => void
    await act(async () => {
      holder.api!.onWorkRow(() => {
        throw new Error('a broken listener')
      })
      off = holder.api!.onWorkRow((event) => heard.push(event))
    })
    await push('UPDATE', row('live', { status: 'done' }))
    await push('INSERT', row('elsewhere', { workspace_id: 'w3' }))
    expect(heard).toEqual([
      { type: 'row', row: expect.objectContaining({ id: 'live', status: 'done' }) },
      { type: 'row', row: expect.objectContaining({ id: 'elsewhere' }) },
    ])
    // Its own patch still lands, and the subscribe stays the same function.
    expect(rowOf('live')?.status).toBe('done')
    expect(holder.api!.onWorkRow).toBe(onWorkRow)
    // The channel comes up again: whoever keeps rows reloads what it missed.
    await act(async () => hoisted.subscribers.get(ledgerChannels().at(-1)!)!('SUBSCRIBED'))
    expect(heard.at(-1)).toEqual({ type: 'resync' })
    off()
    await push('UPDATE', row('review', { status: 'done' }))
    expect(heard).toHaveLength(3)
    expect(errors).toHaveBeenCalledWith('[agent-work] a work-row listener failed:', expect.any(Error))
    errors.mockRestore()
  })

  it('marks a review settled at once, and restores it when the verb fails', async () => {
    await mount()
    await act(async () => {
      await holder.api!.reviewed('review')
    })
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')!
    expect(patch[0]).toBe('/api/account/activity/review')
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ action: 'reviewed' })
    expect(rowOf('review')).toMatchObject({ status: 'done', progress: { review: 'reviewed' } })

    listed = [row('review2', { status: 'needs_review' })]
    await act(async () => {
      await holder.api!.refresh()
    })
    respond = (_url, init) => (init?.method === 'PATCH' ? new Response(JSON.stringify({ error: 'nope' }), { status: 500 }) : null)
    await act(async () => {
      await holder.api!.dismissReview('review2')
    })
    expect(rowOf('review2')?.status).toBe('needs_review')
    expect(hoisted.toast.error).toHaveBeenCalledWith('Could not dismiss', expect.anything())
  })

  it('a question answered takes its row out of waiting at once, with nothing fetched; anything else is left be', async () => {
    listed = [row('q1', { status: 'needs_input', needs: { kind: 'input', questions: ['Which Acme contact?'] } }), row('live')]
    await mount()
    const before = fetchMock.mock.calls.length
    act(() => holder.api!.answered('q1'))
    expect(rowOf('q1')).toMatchObject({ status: 'queued', needs: null })
    act(() => holder.api!.answered('live'))
    expect(rowOf('live')?.status).toBe('running')
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('stops a prospecting run through its route, in the row’s own workspace', async () => {
    listed = [row('prosp', { kind: 'prospecting', workspace_id: 'w2', source: { prospecting_run_id: 'pr1' } })]
    await mount()
    await act(async () => {
      await holder.api!.stop(holder.api!.rows![0] as WorkItem)
    })
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')!
    expect(post[0]).toBe('/api/account/prospecting/runs/pr1/cancel')
    expect((post[1] as RequestInit).headers).toEqual({ 'x-workspace-id': 'w2' })
    expect(holder.api?.stopping.has('prosp')).toBe(true)
    await push('UPDATE', row('prosp', { kind: 'prospecting', workspace_id: 'w2', status: 'canceled', source: { prospecting_run_id: 'pr1' } }))
    expect(holder.api?.stopping.has('prosp')).toBe(false)
  })

  it('a Stop that lost the race (409) clears quietly; a failure says so', async () => {
    listed = [row('ev', { kind: 'eval', source: { eval_run_id: 'er1' } })]
    await mount()
    respond = (_url, init) => (init?.method === 'POST' ? new Response('{}', { status: 409 }) : null)
    await act(async () => {
      await holder.api!.stop(holder.api!.rows![0] as WorkItem)
    })
    expect(holder.api?.stopping.has('ev')).toBe(false)
    expect(hoisted.toast.error).not.toHaveBeenCalled()
    respond = (_url, init) => (init?.method === 'POST' ? new Response('{}', { status: 500 }) : null)
    await act(async () => {
      await holder.api!.stop(holder.api!.rows![0] as WorkItem)
    })
    expect(hoisted.toast.error).toHaveBeenCalledWith('Could not stop this run')
  })

  it('resumes a role in the named workspace, then reloads; a refusal says why and keeps the roster', async () => {
    await mount()
    const before = lightFetches()
    let ok = false
    await act(async () => {
      ok = await holder.api!.resumeRole('w2', 'writer')
    })
    expect(ok).toBe(true)
    const post = fetchMock.mock.calls.find(([url]) => url === AGENT_AUTONOMY_RESUME_URL)!
    expect((post[1] as RequestInit).headers).toEqual({ 'Content-Type': 'application/json', 'x-workspace-id': 'w2' })
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ role: 'writer', workspace_id: 'w2' })
    expect(lightFetches()).toBe(before + 1)

    respond = (url) => (url === AGENT_AUTONOMY_RESUME_URL ? new Response(JSON.stringify({ error: 'Only workspace admins can resume a role' }), { status: 403 }) : null)
    await act(async () => {
      ok = await holder.api!.resumeRole('w2', 'writer')
    })
    expect(ok).toBe(false)
    expect(hoisted.toast.error).toHaveBeenCalledWith('Only workspace admins can resume a role')
  })

  it('says the load failed instead of showing nothing, and tears its channel down on unmount', async () => {
    respond = (url) => (url === AGENT_WORK_LIGHT_URL ? new Response('{}', { status: 500 }) : null)
    await mount()
    expect(holder.api?.failed).toBe(true)
    expect(holder.api?.rows).toBeNull()
    act(() => root.unmount())
    // The ledger's, the one channel.
    expect(hoisted.removeChannel).toHaveBeenCalledTimes(1)
    root = createRoot(container)
  })
  it('reads ?light=1, hands out its rows and card rows, and opens no channel but the ledger’s (no work_touch)', async () => {
    await mount()
    expect(lightFetches()).toBe(1)
    expect(otherRouteFetches()).toBe(0)
    expect(ids()).toEqual(['live', 'review'])
    expect(holder.api?.cardRows.map((r) => r.id)).toEqual(['loop'])
    expect(hoisted.channelNames).toEqual(ledgerChannels())
    const handlers = hoisted.handlers.get(ledgerChannels()[0])!
    expect([...handlers.keys()].sort()).toEqual(['INSERT', 'UPDATE'])
  })

  it('patches a pushed row in (and the row a card points at), and never refetches to name a teammate', async () => {
    await mount()
    await push('UPDATE', row('live', { ai_team_member_id: 'tm-new' }))
    await push('UPDATE', row('loop', { kind: 'flow_run', status: 'done', flow_run_id: 'fr1', ai_team_member_id: 'triage-2' }))
    await act(async () => new Promise((r) => setTimeout(r, 450)))
    await flush()
    expect(lightFetches()).toBe(1)
    expect((holder.api?.rows ?? []).find((r) => r.id === 'live')?.ai_team_member_id).toBe('tm-new')
    expect(holder.api?.cardRows[0].ai_team_member_id).toBe('triage-2')
  })

  // bots-v4 Phase 4b (review of #650): the light read carries the breakers, and
  // attempts are dismissed from the bubble with no Agents page open, so a
  // dismissed attempt reloads the light answer ("Attempts paused" may change).
  it('a dismissed attempt reloads the light answer, once for a burst (debounced)', async () => {
    await mount()
    await push('UPDATE', row('attempt', { origin: 'attempt', status: 'done', progress: { review: 'dismissed' } }))
    await push('UPDATE', row('attempt-2', { origin: 'attempt', status: 'done', progress: { review: 'dismissed' } }))
    await act(async () => new Promise((r) => setTimeout(r, 450)))
    await flush()
    expect(lightFetches()).toBe(2)
    expect(otherRouteFetches()).toBe(0)
  })

  it('the open stamp (migration 295) rides the pushed row', async () => {
    const stamped = '2026-09-30T12:00:00.000Z'
    await mount()
    await push('UPDATE', row('review', { status: 'needs_review', opened_at: stamped }))
    expect(rowOf('review')?.opened_at).toBe(stamped)
  })

  // bots-v4 Phase 4b: the light answer's done rows, and who the AI limit stopped.
  it('a done row the answer carries, with what it made, is held: a "done" peek survives a reload', async () => {
    const drafts = [{ type: 'email_draft', id: 'd1', label: 'Re: pricing' }]
    respond = (url) =>
      url === AGENT_WORK_LIGHT_URL
        ? new Response(
            JSON.stringify({
              light: true,
              items: [
                { id: 'live', workspace_id: 'w1', member_id: 'm1', kind: 'work_run', status: 'running', source: {}, created_at: '2026-10-07T08:00:00.000Z' },
                {
                  id: 'drafted',
                  workspace_id: 'w1',
                  member_id: 'm1',
                  kind: 'email_drafts',
                  status: 'done',
                  ai_team_member_id: 'mail',
                  source: {},
                  opened_at: null,
                  title: 'Drafting pass',
                  finished_at: '2026-10-07T07:01:00.000Z',
                  deliverables: drafts,
                  created_at: '2026-10-07T07:00:00.000Z',
                },
              ],
              card_rows: [],
              roster: [],
              workspace_ids: ['w1'],
              current_workspace_id: 'w1',
            }),
            { status: 200 },
          )
        : null
    await mount()
    const drafted = (holder.api?.rows ?? []).find((r) => r.id === 'drafted') as Record<string, unknown> | undefined
    expect(drafted).toMatchObject({ status: 'done', deliverables: drafts, finished_at: '2026-10-07T07:01:00.000Z', title: 'Drafting pass' })
  })

  it('aiLimited: the answer’s teammates; a pushed run the limit stopped stops its teammate, a later run wakes one; the same map otherwise', async () => {
    const minute = 60_000
    const asOf = new Date(Date.now() - minute).toISOString()
    respond = (url) =>
      url === AGENT_WORK_LIGHT_URL
        ? new Response(
            JSON.stringify({
              light: true,
              items: [],
              card_rows: [],
              roster: [],
              workspace_ids: ['w1'],
              current_workspace_id: 'w1',
              ai_limited: [{ teammate_id: 'writer', workspace_id: 'w1', at: new Date(Date.now() - 2 * minute).toISOString() }],
              ai_limited_as_of: asOf,
            }),
            { status: 200 },
          )
        : null
    await mount()
    expect([...(holder.api?.aiLimited?.keys() ?? [])]).toEqual(['writer'])

    const now = new Date().toISOString()
    await push('INSERT', row('stopped', { status: 'failed', ai_team_member_id: 'researcher', error_message: 'AI usage limit exceeded (plan limit) — skill run skipped', created_at: now, finished_at: now }))
    expect([...(holder.api?.aiLimited?.keys() ?? [])].sort()).toEqual(['researcher', 'writer'])

    // A run of no teammate moves nothing: the same map.
    const before = holder.api!.aiLimited
    await push('INSERT', row('lane', { status: 'running', created_at: now }))
    expect(holder.api!.aiLimited).toBe(before)

    // A later run wakes the writer.
    await push('INSERT', row('writes-again', { status: 'running', ai_team_member_id: 'writer', created_at: new Date(Date.now() + 1).toISOString() }))
    expect([...(holder.api?.aiLimited?.keys() ?? [])]).toEqual(['researcher'])
  })

  it('aiLimited is null until an answer has said (the bot’s page falls back to its own last row)', async () => {
    await mount()
    expect(holder.api?.aiLimited).toBeNull()
  })

  // Review of #650: a stop lifts once it's 48 hours old, with no reload.
  it('aiLimited is aged while anyone is stopped: a stop lifts once it is 48 hours old', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      const asOf = new Date(Date.now() - 60_000).toISOString()
      respond = (url) =>
        url === AGENT_WORK_LIGHT_URL
          ? new Response(
              JSON.stringify({
                light: true,
                items: [],
                card_rows: [],
                roster: [],
                workspace_ids: ['w1'],
                current_workspace_id: 'w1',
                // Stopped 47h59m ago: a minute left.
                ai_limited: [{ teammate_id: 'writer', workspace_id: 'w1', at: new Date(Date.now() - 48 * 3_600_000 + 60_000).toISOString() }],
                ai_limited_as_of: asOf,
              }),
              { status: 200 },
            )
          : null
      await mount()
      expect([...(holder.api?.aiLimited?.keys() ?? [])]).toEqual(['writer'])
      await act(async () => {
        vi.advanceTimersByTime(AI_LIMIT_AGE_MS)
      })
      await flush()
      expect(holder.api?.aiLimited?.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a load waits for the ledger channel to be up; a slow channel holds it back SUBSCRIBE_WAIT_MS at most, then it loads again once up', async () => {
    hoisted.holdSubscribe = true
    await mount()
    expect(lightFetches()).toBe(0)
    await bringUp()
    expect(lightFetches()).toBe(1)

    act(() => root.unmount())
    root = createRoot(container)
    vi.useFakeTimers()
    try {
      hoisted.holdSubscribe = true
      await mount()
      expect(lightFetches()).toBe(1)
      await act(async () => vi.advanceTimersByTime(SUBSCRIBE_WAIT_MS))
      await flush()
      expect(lightFetches()).toBe(2)
      expect(holder.api?.rows).not.toBeNull()
      // Up at last: once more, for what landed while it was down.
      await bringUp()
      expect(lightFetches()).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a channel that fails to come up does not hold the load back', async () => {
    hoisted.holdSubscribe = true
    await mount()
    expect(lightFetches()).toBe(0)
    await act(async () => hoisted.subscribers.get(ledgerChannels()[0])!('CHANNEL_ERROR'))
    await flush()
    expect(lightFetches()).toBe(1)
    // Its recovery reloads.
    await bringUp()
    expect(lightFetches()).toBe(2)
  })

  it('enabled: false loads nothing and subscribes nothing until enabled', async () => {
    await mount(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(hoisted.channelNames).toEqual([])
    expect(holder.api?.rows).toBeNull()
    await mount(true)
    expect(lightFetches()).toBe(1)
    expect(hoisted.channelNames).toHaveLength(1)
  })

  it('reloads the roster when a teammate changes, here or in another of the app’s windows (a voice or face saved in the editor), and nothing else', async () => {
    const { TEAMMATES_CHANGED_KEY, announceTeammatesChanged } = await import('@/lib/bots/teammates-changed')
    await mount()
    expect(lightFetches()).toBe(1)
    // Saved in this window.
    await act(async () => announceTeammatesChanged())
    await flush()
    expect(lightFetches()).toBe(2)
    // Saved in another window: its ping in the shared storage.
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: TEAMMATES_CHANGED_KEY, newValue: '1700000000000:9' })))
    await flush()
    expect(lightFetches()).toBe(3)
    // Any other storage write is none of its business.
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: 'ni:bots:cast', newValue: '{}' })))
    await flush()
    expect(lightFetches()).toBe(3)
    // Unmounted: nobody reloads.
    act(() => root.unmount())
    announceTeammatesChanged()
    await flush()
    expect(lightFetches()).toBe(3)
    root = createRoot(container)
  })
})

describe('useAgentWork — a failed load retries', () => {
  const after = async (ms: number) => {
    await act(async () => vi.advanceTimersByTime(ms))
    await flush()
  }
  const returnToWindow = () =>
    act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('after 2 s, 8 s, 30 s, then every 2 minutes, until one lands; then no more', async () => {
    let down = true
    respond = (url) => (url === AGENT_WORK_LIGHT_URL && down ? new Response('{}', { status: 503 }) : null)
    await mount()
    expect(lightFetches()).toBe(1)
    expect(holder.api?.failed).toBe(true)
    expect(holder.api?.rows).toBeNull()
    await after(1_999)
    expect(lightFetches()).toBe(1)
    await after(1)
    expect(lightFetches()).toBe(2)
    await after(7_999)
    expect(lightFetches()).toBe(2)
    await after(1)
    expect(lightFetches()).toBe(3)
    await after(30_000)
    expect(lightFetches()).toBe(4)
    await after(120_000)
    expect(lightFetches()).toBe(5)
    await after(120_000)
    expect(lightFetches()).toBe(6)
    down = false
    await after(120_000)
    expect(lightFetches()).toBe(7)
    expect(holder.api?.failed).toBe(false)
    expect((holder.api?.rows ?? []).map((r) => r.id)).toEqual(['live', 'review'])
    // Rows held again, so pushes land.
    await push('UPDATE', row('live', { status: 'done' }))
    expect((holder.api?.rows ?? []).find((r) => r.id === 'live')?.status).toBe('done')
    await after(600_000)
    expect(lightFetches()).toBe(7)
  })

  it('a network failure retries the same way', async () => {
    let down = true
    const realFetch = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === AGENT_WORK_LIGHT_URL && down) throw new TypeError('Failed to fetch')
      return realFetch(url, init)
    })
    await mount()
    expect(holder.api?.failed).toBe(true)
    down = false
    await after(2_000)
    expect(lightFetches()).toBe(2)
    expect(holder.api?.failed).toBe(false)
  })

  it('retries at once when the window comes back into focus, once for focus and visibility together', async () => {
    let down = true
    respond = (url) => (url === AGENT_WORK_LIGHT_URL && down ? new Response('{}', { status: 500 }) : null)
    await mount()
    expect(lightFetches()).toBe(1)
    await returnToWindow()
    await flush()
    expect(lightFetches()).toBe(2)
    down = false
    await returnToWindow()
    await flush()
    expect(lightFetches()).toBe(3)
    expect(holder.api?.failed).toBe(false)
    // Loaded: coming back loads nothing.
    await returnToWindow()
    await flush()
    expect(lightFetches()).toBe(3)
  })

  it('signed out (401 twice running): only every 2 minutes, and the window leaves it be', async () => {
    respond = (url) => (url === AGENT_WORK_LIGHT_URL ? new Response('{}', { status: 401 }) : null)
    await mount()
    await after(2_000)
    expect(lightFetches()).toBe(2)
    await after(8_000)
    expect(lightFetches()).toBe(2)
    await returnToWindow()
    await flush()
    expect(lightFetches()).toBe(2)
    await after(111_999)
    expect(lightFetches()).toBe(2)
    await after(1)
    expect(lightFetches()).toBe(3)
    await after(120_000)
    expect(lightFetches()).toBe(4)
  })

  it('stops with the mount', async () => {
    respond = (url) => (url === AGENT_WORK_LIGHT_URL ? new Response('{}', { status: 500 }) : null)
    await mount()
    await after(2_000)
    await after(8_000)
    expect(lightFetches()).toBe(3)
    act(() => root.unmount())
    root = createRoot(container)
    await after(600_000)
    expect(lightFetches()).toBe(3)
  })
})
