// @vitest-environment jsdom
/**
 * useBotWork (docs/plans/bots-v4.md Phase 1a): one teammate's work, for its
 * bot, kept live off the shell's own `tracked_job` channel.
 *
 *   • it loads GET /api/account/agent-work?teammate=<id> while asked (scope
 *     'last': `&last=1`), and nothing while it's asked for no one;
 *   • a pushed row is patched in with no refetch when it's the teammate's
 *     own, or in a handoff tree it holds; another teammate's row outside its
 *     trees, and a row in another workspace, are left out;
 *   • a row naming a teammate it can't name refetches once, however often it's
 *     pushed; scope 'last' names no one, so never;
 *   • its last finished row moves on to an own row that settled later, and to
 *     nothing else;
 *   • a push that lands while a load is in flight is re-applied over its
 *     answer; another teammate starts over, and a late answer for the one it
 *     left is dropped; the channel coming up again reloads it;
 *   • a 404 (not a teammate you can read) is final, and drops whatever an
 *     earlier answer held; any other failure retries and keeps it on show;
 *   • a running row's chips stay fresh off its pushes (bots-v4 Phase 7, no
 *     `work_touch` channel): a held running row that moved on reloads at most
 *     once per CHIP_REFRESH_RUNNING_MS, a row that just stopped reloads once
 *     CHIP_REFRESH_SETTLED_MS later, and no chip reload starts while a load is
 *     in flight (a slow read under constant pushes still lands); a heartbeat,
 *     a row with its three chips, a settled row, another teammate's row and
 *     scope 'last' never reload.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'
import type { WorkRowEvent, WorkRowListener } from '@/hooks/use-agent-work'
import type { WorkItem } from '@/lib/work/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The shell's channel, as useOnWorkRow hands it on: one stable subscribe.
const bus = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>()
  return {
    listeners,
    onWorkRow: (listener: (event: unknown) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
})
vi.mock('@/components/work/agent-work-provider', () => ({ useOnWorkRow: () => bus.onWorkRow }))

import { BOT_WORK_URL, CHIP_REFRESH_RUNNING_MS, CHIP_REFRESH_SETTLED_MS, botWorkUrl, useBotWork, type BotWork, type BotWorkScope } from '../use-bot-work'

const WRITER = 'tm-writer'
const TEAMMATE_EMBED = { id: WRITER, name: 'Writer', is_system: false, system_key: null, role: 'writer', bot_character: null }

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
    created_at: '2026-10-03T08:00:00.000Z',
    started_at: null,
    finished_at: null,
    reviewed_at: null,
    last_beat_at: '2026-10-03T08:00:00.000Z',
    deadline_at: null,
    ai_team_member_id: WRITER,
    parent_id: null,
    root_id: null,
    teammate: TEAMMATE_EMBED,
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
/** What the route answers, per teammate id (a status code: that failure). */
let answers: Record<string, Record<string, unknown> | number>
const holder: { work: BotWork | null } = { work: null }
const asked: { teammateId: string | null; scope: BotWorkScope } = { teammateId: WRITER, scope: 'all' }

function Probe() {
  const work = useBotWork(asked.teammateId, { scope: asked.scope })
  useEffect(() => {
    holder.work = work
  }, [work])
  return null
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function render(teammateId: string | null = WRITER, scope: BotWorkScope = 'all') {
  asked.teammateId = teammateId
  asked.scope = scope
  await act(async () => root.render(h(Probe)))
  await flush()
}

/** A row or a resync from the shell's channel, to everyone listening. */
async function emit(event: WorkRowEvent) {
  await act(async () => {
    for (const listener of [...bus.listeners]) (listener as WorkRowListener)(event)
    await Promise.resolve()
  })
}
const push = (r: WorkItem) => emit({ type: 'row', row: r })

/** Past the debounce (and anything it starts). */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await flush()
}

const fetchesFor = (teammateId: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(`teammate=${teammateId}`)).length
const ids = () => (holder.work?.rows ?? []).map((r) => r.id)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  holder.work = null
  bus.listeners.clear()
  answers = {
    [WRITER]: {
      teammate_id: WRITER,
      workspace_id: 'w1',
      items: [
        row('live', { created_at: '2026-10-03T09:00:00.000Z' }),
        row('root', { status: 'waiting_on_child', created_at: '2026-10-03T08:00:00.000Z' }),
      ],
      chips: {},
      teammate: { id: WRITER, name: 'Writer', breaker: null },
      may_resume: true,
      last_finished: row('done', { status: 'done', finished_at: '2026-10-02T10:00:00.000Z', created_at: '2026-10-02T09:00:00.000Z' }),
    },
  }
  fetchMock = vi.fn(async (url: string) => {
    const id = new URL(url, 'http://x').searchParams.get('teammate') ?? ''
    const answer = answers[id]
    if (typeof answer === 'number') return new Response(JSON.stringify({ error: 'no' }), { status: answer })
    return new Response(JSON.stringify(answer ?? { error: 'Teammate not found' }), { status: answer ? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useBotWork', () => {
  it('loads one teammate’s work while asked, and nothing while asked for no one', async () => {
    await render(null)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(bus.listeners.size).toBe(0)
    expect(holder.work).toMatchObject({ rows: null, lastFinished: null, mayResume: false })

    await render(WRITER)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${BOT_WORK_URL}?teammate=${WRITER}`])
    expect(ids()).toEqual(['live', 'root'])
    expect(holder.work).toMatchObject({ mayResume: true, teammate: { id: WRITER }, lastFinished: { id: 'done' }, failed: false })
    expect(bus.listeners.size).toBe(1)

    // Asked for no one again: nothing held, nothing heard.
    await render(null)
    expect(holder.work?.rows).toBeNull()
    expect(bus.listeners.size).toBe(0)
    expect(botWorkUrl('a b', 'last')).toBe(`${BOT_WORK_URL}?teammate=a%20b&last=1`)
  })

  it('carries what its About says (bots-v4.md Phase 1b), and nothing for an answer without it', async () => {
    answers[WRITER] = {
      ...(answers[WRITER] as Record<string, unknown>),
      skills: [{ id: 's1', name: 'Research brief' }],
      agent: { id: 'agent-1', name: 'Sales Coach' },
      loops: [{ id: 'flow-1', name: 'Weekly brief' }],
    }
    await render(WRITER)
    expect(holder.work?.about).toEqual({
      skills: [{ id: 's1', name: 'Research brief' }],
      agent: { id: 'agent-1', name: 'Sales Coach' },
      loops: [{ id: 'flow-1', name: 'Weekly brief' }],
    })
    await render(null)
    expect(holder.work?.about).toEqual({ skills: [], agent: null, loops: [] })
  })

  it('patches a pushed row of its own in, with no refetch', async () => {
    await render()
    await push(row('live', { status: 'needs_review', created_at: '2026-10-03T09:00:00.000Z', teammate: undefined }))
    await push(row('new', { created_at: '2026-10-03T10:00:00.000Z', teammate: undefined }))
    expect(ids()).toEqual(['new', 'live', 'root'])
    expect(holder.work?.rows?.find((r) => r.id === 'live')).toMatchObject({ status: 'needs_review', teammate: TEAMMATE_EMBED })
    // (Under CHIP_REFRESH_SETTLED_MS: its chips' own reload is tested below.)
    await wait(1000)
    expect(fetchesFor(WRITER)).toBe(1)
  })

  it('patches in a row in a handoff tree it holds, and leaves out another teammate’s row outside them and a row in another workspace', async () => {
    await render()
    // A handoff from its run, to another teammate; that teammate's own run; its own run in another workspace.
    await push(row('handoff', { ai_team_member_id: 'tm-res', parent_id: 'root', root_id: 'root', created_at: '2026-10-03T10:00:00.000Z', teammate: undefined }))
    await push(row('elsewhere', { ai_team_member_id: 'tm-res', created_at: '2026-10-03T11:00:00.000Z', teammate: undefined }))
    await push(row('other-ws', { workspace_id: 'w2', created_at: '2026-10-03T12:00:00.000Z', teammate: undefined }))
    expect(ids()).toEqual(['handoff', 'live', 'root'])
    // A later row of that tree (the handoff's own handoff) comes in too.
    await push(row('grandchild', { ai_team_member_id: 'tm-res', parent_id: 'handoff', root_id: 'root', created_at: '2026-10-03T13:00:00.000Z', teammate: undefined }))
    expect(ids()).toEqual(['grandchild', 'handoff', 'live', 'root'])
  })

  it('refetches once for a row naming a teammate it can’t name, however often it’s pushed', async () => {
    await render()
    expect(fetchesFor(WRITER)).toBe(1)
    const handoff = row('handoff', { ai_team_member_id: 'tm-new', parent_id: 'root', root_id: 'root', created_at: '2026-10-03T10:00:00.000Z', teammate: undefined })
    await push(handoff)
    await push({ ...handoff, status: 'done' })
    await wait(500)
    expect(fetchesFor(WRITER)).toBe(2)
    // Still unnamed after the refetch (the answer can't name it either): no more.
    await push({ ...handoff, status: 'done', current_step: 'again' })
    await wait(500)
    expect(fetchesFor(WRITER)).toBe(2)
  })

  it('moves its last finished on to an own row that settled later, and to nothing else; scope \'last\' never refetches', async () => {
    answers[WRITER] = { teammate_id: WRITER, workspace_id: 'w1', last_finished: (answers[WRITER] as { last_finished: WorkItem }).last_finished }
    await render(WRITER, 'last')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${BOT_WORK_URL}?teammate=${WRITER}&last=1`])
    expect(holder.work?.lastFinished?.id).toBe('done')
    expect(holder.work?.rows).toEqual([])

    await push(row('still-running', { teammate: undefined }))
    await push(row('older', { status: 'done', finished_at: '2026-10-01T10:00:00.000Z', teammate: undefined }))
    await push(row('theirs', { status: 'done', ai_team_member_id: 'tm-other', finished_at: '2026-10-03T10:00:00.000Z', teammate: undefined }))
    expect(holder.work?.lastFinished?.id).toBe('done')

    await push(row('newer', { status: 'failed', finished_at: '2026-10-03T10:00:00.000Z', teammate: undefined }))
    // A pushed row has no teammate embed: it keeps the one its last finished had.
    expect(holder.work?.lastFinished).toMatchObject({ id: 'newer', status: 'failed', teammate: TEAMMATE_EMBED })
    expect(holder.work?.rows).toEqual([])
    await wait(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-applies a push that landed while its load was in flight over the answer', async () => {
    let release!: () => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(JSON.stringify(answers[WRITER]), { status: 200 }))
        }),
    )
    await render()
    expect(holder.work?.rows).toBeNull()
    await push(row('live', { status: 'done', finished_at: '2026-10-03T09:30:00.000Z', created_at: '2026-10-03T09:00:00.000Z', teammate: undefined }))
    await act(async () => release())
    await flush()
    expect(holder.work?.rows?.find((r) => r.id === 'live')?.status).toBe('done')
    expect(holder.work?.lastFinished?.id).toBe('live')
  })

  it('starts over for another teammate, and drops a late answer for the one it left', async () => {
    let release!: () => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(JSON.stringify(answers[WRITER]), { status: 200 }))
        }),
    )
    answers['tm-res'] = { teammate_id: 'tm-res', workspace_id: 'w1', items: [row('res-1', { ai_team_member_id: 'tm-res' })], last_finished: null }
    await render(WRITER)
    await render('tm-res')
    expect(ids()).toEqual(['res-1'])
    await act(async () => release())
    await flush()
    expect(ids()).toEqual(['res-1'])
    expect(holder.work?.lastFinished).toBeNull()
  })

  it('reloads when the shell’s channel comes up again (what was pushed in between was missed)', async () => {
    await render()
    await emit({ type: 'resync' })
    await emit({ type: 'resync' })
    await wait(500)
    expect(fetchesFor(WRITER)).toBe(2)
  })

  it('a 404 is final; any other failure retries by itself', async () => {
    answers[WRITER] = 404
    await render()
    expect(holder.work?.failed).toBe(true)
    await wait(130_000)
    expect(fetchesFor(WRITER)).toBe(1)

    act(() => root.unmount())
    root = createRoot(container)
    answers['tm-flaky'] = 503
    await render('tm-flaky')
    expect(holder.work?.failed).toBe(true)
    answers['tm-flaky'] = { teammate_id: 'tm-flaky', workspace_id: 'w1', items: [row('back', { ai_team_member_id: 'tm-flaky' })] }
    await wait(2_100)
    expect(fetchesFor('tm-flaky')).toBe(2)
    expect(holder.work).toMatchObject({ failed: false })
    expect(ids()).toEqual(['back'])
  })

  it('drops what it held once a later answer says it isn’t yours to read (taken off its private team); a passing failure keeps it', async () => {
    await render()
    expect(ids()).toEqual(['live', 'root'])
    // A passing failure: what it held stays on show while it retries.
    answers[WRITER] = 503
    await emit({ type: 'resync' })
    await wait(500)
    expect(holder.work).toMatchObject({ failed: true, lastFinished: { id: 'done' } })
    expect(ids()).toEqual(['live', 'root'])
    // Refused now (its retry): nothing it held stays, and it doesn't ask again.
    answers[WRITER] = 404
    await wait(2_100)
    expect(holder.work).toMatchObject({ failed: true, rows: null, lastFinished: null, teammate: null, mayResume: false })
    const asked = fetchesFor(WRITER)
    await wait(130_000)
    expect(fetchesFor(WRITER)).toBe(asked)
  })

  describe('a running row’s chips, fresh off its pushes', () => {
    const chip = (id: string) => ({ entity_type: 'contact' as const, entity_id: id, wrote: true, label: `Contact ${id}` })
    const live = (over: Partial<WorkItem> = {}) => row('live', { created_at: '2026-10-03T09:00:00.000Z', teammate: undefined, ...over })
    const withChips = (chips: Record<string, unknown>) => {
      answers[WRITER] = { ...(answers[WRITER] as Record<string, unknown>), chips }
    }

    it('a new step reloads its chips once CHIP_REFRESH_RUNNING_MS has passed, and the chips it touched show', async () => {
      await render()
      expect(holder.work?.chips).toEqual({})
      withChips({ live: [chip('c1')] })
      await push(live({ current_step: 'Reading Dana’s contact' }))
      await wait(CHIP_REFRESH_RUNNING_MS - 1)
      expect(fetchesFor(WRITER)).toBe(1)
      await wait(1)
      expect(fetchesFor(WRITER)).toBe(2)
      expect(holder.work?.chips).toEqual({ live: [chip('c1')] })
    })

    it('a run writing its step every 2 s reloads once per CHIP_REFRESH_RUNNING_MS, not on every step', async () => {
      await render()
      for (let t = 0; t < 30_000; t += 2000) {
        await push(live({ current_step: `step at ${t}` }))
        await wait(2000)
      }
      // 30 s of steps: a reload at 12 s and one at 24 s (each push after a reload arms the next).
      expect(fetchesFor(WRITER)).toBe(3)
    })

    it('the push that stops it (done) reloads once, CHIP_REFRESH_SETTLED_MS later, ahead of a running wait', async () => {
      await render()
      await push(live({ current_step: 'a' }))
      await wait(1000)
      await push(live({ status: 'done', finished_at: '2026-10-03T10:00:00.000Z' }))
      await wait(CHIP_REFRESH_SETTLED_MS - 1)
      expect(fetchesFor(WRITER)).toBe(1)
      await wait(1)
      expect(fetchesFor(WRITER)).toBe(2)
      // The running wait it replaced doesn't come back.
      await wait(CHIP_REFRESH_RUNNING_MS * 2)
      expect(fetchesFor(WRITER)).toBe(2)
    })

    it('no chip reload starts while a load is in flight: a slow read under constant pushes still lands, and loading ends', async () => {
      await render()
      // The next reads are slow: each answers only when the test says.
      const releases: Array<() => void> = []
      const real = fetchMock.getMockImplementation()!
      fetchMock.mockImplementation(async (url: string) => {
        await new Promise<void>((resolve) => releases.push(resolve))
        return real(url)
      })
      withChips({ live: [chip('c1')] })
      await push(live({ current_step: 'a' }))
      await wait(CHIP_REFRESH_RUNNING_MS)
      expect(fetchesFor(WRITER)).toBe(2)
      expect(holder.work?.loading).toBe(true)
      // The run keeps moving for longer than a whole wait while the read is out.
      for (let t = 0; t < CHIP_REFRESH_RUNNING_MS * 3; t += 2000) {
        await push(live({ current_step: `step at ${t}` }))
        await wait(2000)
      }
      expect(fetchesFor(WRITER)).toBe(2)
      // It lands: its answer is held, loading ends, and the chips show.
      await act(async () => releases.shift()!())
      await flush()
      expect(holder.work?.loading).toBe(false)
      expect(holder.work?.chips).toEqual({ live: [chip('c1')] })
      // The reload that came due meanwhile goes once, now that nothing is in flight.
      await wait(CHIP_REFRESH_RUNNING_MS)
      expect(fetchesFor(WRITER)).toBe(3)
      await act(async () => releases.shift()!())
      await flush()
      expect(holder.work?.loading).toBe(false)
    })

    it('never for a heartbeat, a row showing its three chips, a settled row, a row it doesn’t hold, or a row new to it', async () => {
      withChips({ root: [chip('a'), chip('b'), chip('c')] })
      answers[WRITER] = {
        ...(answers[WRITER] as Record<string, unknown>),
        items: [...((answers[WRITER] as { items: WorkItem[] }).items), row('settled', { status: 'done', created_at: '2026-10-03T07:00:00.000Z' })],
      }
      await render()
      // A heartbeat: nothing but the beat moved.
      await push(live({ last_beat_at: '2026-10-03T09:05:00.000Z' }))
      // Its three chips already show.
      await push(row('root', { status: 'waiting_on_child', current_step: 'next', teammate: undefined }))
      // Settled before, settled after.
      await push(row('settled', { status: 'done', current_step: 'x', created_at: '2026-10-03T07:00:00.000Z', teammate: undefined }))
      // Another teammate's row outside its trees, and a row it never held.
      await push(row('theirs', { ai_team_member_id: 'tm-other', current_step: 'y', teammate: undefined }))
      await push(row('brand-new', { current_step: 'z', created_at: '2026-10-03T11:00:00.000Z', teammate: undefined }))
      await wait(CHIP_REFRESH_RUNNING_MS * 2)
      expect(fetchesFor(WRITER)).toBe(1)
    })

    it('scope \'last\' holds no rows, so never', async () => {
      await render(WRITER, 'last')
      await push(live({ current_step: 'a' }))
      await wait(CHIP_REFRESH_RUNNING_MS * 2)
      expect(fetchesFor(WRITER)).toBe(1)
    })
  })
})
