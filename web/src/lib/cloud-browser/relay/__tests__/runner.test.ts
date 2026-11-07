/**
 * The relay's command runner (src/lib/cloud-browser/relay/runner.ts), the
 * cloud twin of the desktop relay's runOne: the same refusals and results,
 * against a stub browser and relay client.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ execute: vi.fn(), command: vi.fn() }))
vi.mock('@/lib/browser-agent/task-executor', async (original) => ({
  ...(await original<typeof import('@/lib/browser-agent/task-executor')>()),
  executeBrowserTask: mock.execute,
}))
vi.mock('../../cdp/commands', async (original) => ({
  ...(await original<typeof import('../../cdp/commands')>()),
  runCloudCommand: mock.command,
}))

import { BrowserSiteBlockedError } from '@/lib/browser-agent/blocked-sites'
import { runClaimed, type RelayState } from '../runner'
import { exitControl } from '../exit-control'
import type { ClaimedCommand } from '../client'

function stubPage(targetId: string, url = 'https://example.com/') {
  return { targetId, url, closed: false, setGuard: vi.fn(async () => {}), onNotice: () => () => {},
    decisionSnapshot: vi.fn(), taskAction: vi.fn(), navigate: vi.fn() }
}
let pages: ReturnType<typeof stubPage>[]
let settled: [string, string, unknown, string | null][]
let state: RelayState
const decide = vi.fn()

function command(fields: Partial<ClaimedCommand>): ClaimedCommand {
  return { id: 'cmd-1', command: 'get_text', tab_id: null, request: {}, workspace_id: 'ws-1',
    claimed_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + 60_000).toISOString(), ...fields }
}
const task = (fields: Record<string, unknown> = {}) => ({ task: { goal: 'Find the price', goalDriven: true, ...fields } })

beforeEach(() => {
  pages = []
  settled = []
  decide.mockReset()
  mock.execute.mockReset().mockResolvedValue({ status: 'verified', reason: 'done', steps: 1 })
  mock.command.mockReset().mockResolvedValue({ url: 'https://example.com/', text: 'Hi' })
  const browser = {
    list: () => pages,
    openPage: vi.fn(async () => { const page = stubPage(`tab-${pages.length + 1}`, 'about:blank'); pages.push(page); return page }),
  }
  state = {
    browser: browser as unknown as RelayState['browser'],
    client: { settle: async (...args: [string, string, unknown, string | null]) => { settled.push(args) }, decide,
      requestApproval: async () => null } as unknown as RelayState['client'],
    agentPage: null,
  }
})

describe('runClaimed', () => {
  it('runs a read in the agent’s tab, opening one when there is none', async () => {
    await runClaimed(state, command({ command: 'get_text', request: { maxChars: 10 } }), [])
    expect(mock.command).toHaveBeenCalledWith(pages[0], 'get_text', { maxChars: 10 }, [])
    expect(settled).toEqual([['cmd-1', 'completed', { url: 'https://example.com/', text: 'Hi' }, null]])
    expect(state.agentPage).toBe(pages[0])
  })

  it('never lands a write or a replayed snapshot on another tab than the one named', async () => {
    await runClaimed(state, command({ command: 'run_task', tab_id: 'gone', request: task() }), [])
    expect(settled[0]).toEqual(['cmd-1', 'failed', null, expect.stringContaining('tab is closed')])
    expect(mock.execute).not.toHaveBeenCalled()
  })

  it('refuses a task that starts on a blocked site, before it opens anything', async () => {
    await runClaimed(state, command({ command: 'run_task', request: task({ startUrl: 'https://www.linkedin.com/feed' }) }), ['linkedin.com'])
    expect(settled[0]).toEqual(['cmd-1', 'completed', expect.objectContaining({ reason: 'site_blocked', blockedSite: 'linkedin.com' }), null])
    expect(pages).toEqual([])
  })

  it('never reads a tab that shows a blocked site, and a task with a start page gets its own tab', async () => {
    const blockedTab = stubPage('tab-1', 'https://www.linkedin.com/feed')
    pages.push(blockedTab)
    state.agentPage = blockedTab as unknown as RelayState['agentPage']
    await runClaimed(state, command({ command: 'get_text' }), ['linkedin.com'])
    expect(settled[0]).toEqual(['cmd-1', 'denied', null, expect.stringContaining('linkedin.com')])
    await runClaimed(state, command({ id: 'cmd-2', command: 'run_task', request: task() }), ['linkedin.com'])
    expect(settled[1]).toEqual(['cmd-2', 'completed', expect.objectContaining({ reason: 'site_blocked', tabId: 'tab-1' }), null])
    await runClaimed(state, command({ id: 'cmd-3', command: 'run_task', request: task({ startUrl: 'https://example.com/' }) }), ['linkedin.com'])
    expect(mock.execute).toHaveBeenCalledTimes(1)
    expect(state.agentPage).toBe(pages[1])
  })

  it('runs a task with the guard on for its deadline, the decision route as its brain, and settles its result with the tab', async () => {
    let ports: Record<string, (...args: unknown[]) => unknown> = {}
    mock.execute.mockImplementation(async (_task: unknown, given: typeof ports) => { ports = given; return { status: 'verified', reason: 'done' } })
    await runClaimed(state, command({ command: 'run_task', request: task() }), ['linkedin.com'])
    const page = pages[0]
    expect(page.setGuard).toHaveBeenCalledWith(['linkedin.com'], expect.any(Number))
    expect(page.setGuard).toHaveBeenLastCalledWith([], 0)
    expect(settled[0]).toEqual(['cmd-1', 'completed', expect.objectContaining({ status: 'verified', tabId: 'tab-1', telemetry: { version: 1, setupMs: expect.any(Number) } }), null])
    expect(await ports.approve('Place order')).toBe(false)

    decide.mockResolvedValueOnce({ status: 200, body: { decision: { status: 'accepted' }, blockedSites: ['linkedin.com', 'x.com'] } })
    expect(await ports.decide({ url: 'https://example.com/' }, 0, [], new AbortController().signal)).toMatchObject({ decision: { status: 'accepted' } })
    expect(decide).toHaveBeenCalledWith('cmd-1', expect.objectContaining({ controllerVersion: 8, tabId: 'tab-1', step: 0 }), expect.any(AbortSignal))
    expect((ports.blockedSites as () => string[])()).toEqual(['linkedin.com', 'x.com'])

    decide.mockResolvedValueOnce({ status: 409, body: { error: 'site_blocked', blockedSite: 'x.com' } })
    await expect(ports.decide({}, 1, [], new AbortController().signal)).rejects.toBeInstanceOf(BrowserSiteBlockedError)
    decide.mockResolvedValueOnce({ status: 409, body: { error: 'Task is no longer authorized' } })
    await expect(ports.decide({}, 1, [], new AbortController().signal)).rejects.toThrow('Decision task unavailable')
  })

  it('fails a task whose lease already ran out', async () => {
    await runClaimed(state, command({ command: 'run_task', request: task(), lease_expires_at: new Date(Date.now() - 1).toISOString() }), [])
    expect(settled[0]).toEqual(['cmd-1', 'failed', null, 'Task lease expired'])
  })

  it('retries a read through a mid-load page, but never a write', async () => {
    mock.command.mockRejectedValueOnce(new Error('agent runtime not present')).mockResolvedValueOnce({ ok: true })
    await runClaimed(state, command({ command: 'read_page' }), [])
    expect(mock.command).toHaveBeenCalledTimes(2)
    expect(settled[0][1]).toBe('completed')
    mock.command.mockReset().mockRejectedValue(new Error('timed out'))
    await runClaimed(state, command({ id: 'cmd-2', command: 'go_back' }), [])
    expect(mock.command).toHaveBeenCalledTimes(1)
    expect(settled[1]).toEqual(['cmd-2', 'failed', null, 'timed out'])
  })

  it('denies a read that reached a blocked site, and answers window commands without the sandbox', async () => {
    mock.command.mockRejectedValueOnce(new BrowserSiteBlockedError('x.com'))
    await runClaimed(state, command({ command: 'read_page' }), [])
    expect(settled[0]).toEqual(['cmd-1', 'denied', null, expect.stringContaining('x.com')])
    await runClaimed(state, command({ id: 'cmd-2', command: 'open_window' }), [])
    expect(settled[1]).toEqual(['cmd-2', 'completed', { ok: true }, null])
  })
})

describe('approvals in the cloud', () => {
  const step = 'Place order\nTotal $42.10\nhttps://shop.example.com'
  const portsOf = async (request: Record<string, unknown>) => {
    let ports: Record<string, (...args: unknown[]) => unknown> = {}
    mock.execute.mockImplementation(async (_task: unknown, given: typeof ports) => {
      ports = given
      return { status: 'cancelled', reason: (await given.approve(step)) ? 'goal_and_predicates_satisfied' : 'approval_declined' }
    })
    await runClaimed(state, command({ command: 'run_task', request }), [])
    return ports
  }

  it('raises a card for the step and stops, saying a card is waiting', async () => {
    const requestApproval = vi.fn(async () => 'approval-1')
    ;(state.client as unknown as { requestApproval: typeof requestApproval }).requestApproval = requestApproval
    await portsOf(task())
    expect(requestApproval).toHaveBeenCalledWith('cmd-1', step, 'tab-1')
    expect(settled[0]).toEqual(['cmd-1', 'completed', expect.objectContaining({ status: 'cancelled', reason: 'approval_requested', approvalId: 'approval-1' }), null])
  })

  it('lets the approved step through once on the replay, never another', async () => {
    const { browserApprovalStep } = await import('@/lib/browser-agent/approval-grant')
    const requestApproval = vi.fn(async () => 'approval-2')
    ;(state.client as unknown as { requestApproval: typeof requestApproval }).requestApproval = requestApproval
    const ports = await portsOf({ ...task(), approvalGrant: { approval_id: 'approval-1', ...browserApprovalStep(step)! } })
    expect(settled[0][2]).toMatchObject({ reason: 'goal_and_predicates_satisfied' })
    expect(requestApproval).not.toHaveBeenCalled()
    expect(await ports.approve(step)).toBe(false)
    expect(await ports.approve('Delete account\n\nhttps://shop.example.com')).toBe(false)
  })

  it('reports a plain refusal when the card could not be raised', async () => {
    ;(state.client as unknown as { requestApproval: () => Promise<null> }).requestApproval = async () => null
    await portsOf(task())
    expect(settled[0][2]).toMatchObject({ reason: 'approval_declined' })
  })
})

describe('when the person has the browser', () => {
  it('runs nothing for the agent: a task ends taken_over, a read says why', async () => {
    await runClaimed(state, command({ command: 'run_task', request: task() }), [], 'person')
    expect(settled[0]).toEqual(['cmd-1', 'completed', expect.objectContaining({ status: 'cancelled', reason: 'taken_over' }), null])
    await runClaimed(state, command({ id: 'cmd-2', command: 'get_text' }), [], 'person')
    expect(settled[1]).toEqual(['cmd-2', 'failed', null, expect.stringContaining('taken over')])
    expect(mock.execute).not.toHaveBeenCalled()
    expect(pages).toEqual([])
  })

  it('stops a running task at its next step when the person takes over', async () => {
    let alive = () => true
    mock.execute.mockImplementation(async (_task: unknown, ports: { decide: (...args: unknown[]) => Promise<unknown>; alive: () => boolean }) => {
      alive = ports.alive
      await ports.decide({}, 0, [], new AbortController().signal).catch(() => {})
      return { status: 'escalate', reason: 'transport_or_write_outcome_unknown' }
    })
    decide.mockResolvedValueOnce({ status: 409, body: { error: 'taken_over' } })
    await runClaimed(state, command({ command: 'run_task', request: task() }), [])
    expect(alive()).toBe(false)
    expect(settled[0]).toEqual(['cmd-1', 'completed', expect.objectContaining({ status: 'cancelled', reason: 'taken_over' }), null])
  })
})

describe('the Mac exit (C4)', () => {
  function withExit(up: boolean) {
    const listeners = new Set<(up: boolean) => void>()
    let mode: 'mac' | 'cloud' = 'cloud'
    const route = {
      up,
      tunnelUp: () => route.up, tunnelDevice: () => (route.up ? 'mac-1' : null), mode: () => mode,
      setMode: vi.fn((next: 'mac' | 'cloud') => { mode = next }),
      onTunnel: (listener: (up: boolean) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      drop: () => { route.up = false; for (const listener of [...listeners]) listener(false) },
    }
    const setExit = vi.fn(async () => true)
    const markSite = vi.fn(async () => {})
    Object.assign(state.client, { setExit, markSite })
    state.exit = exitControl({ exit: route, report: setExit, bootMode: 'cloud', capable: true })
    return { exit: route, setExit, markSite }
  }
  const memory = (fields: Partial<{ needsHome: string[]; neverAutomate: string[] }> = {}) => ({ needsHome: [], neverAutomate: [], ...fields })

  it('pins a task to the Mac while its tunnel is up: the hub first, then the network policy', async () => {
    const { exit, setExit } = withExit(true)
    await runClaimed(state, command({ command: 'run_task', request: task({ startUrl: 'https://resy.com/' }) }), [], 'agent', memory())
    expect(exit.setMode).toHaveBeenCalledWith('mac')
    expect(setExit).toHaveBeenCalledWith('mac', { up: true, deviceId: 'mac-1' })
    expect(exit.setMode.mock.invocationCallOrder[0]).toBeLessThan(setExit.mock.invocationCallOrder[0])
    expect(settled[0][2]).toMatchObject({ exit: 'mac' })
  })

  it('with the Mac away, says a site that needs it needs it instead of trying from the cloud', async () => {
    withExit(false)
    await runClaimed(state, command({ command: 'run_task', request: task({ startUrl: 'https://www.uniqlo.com/us/en/' }) }), [], 'agent', memory({ needsHome: ['uniqlo.com'] }))
    expect(settled[0][2]).toMatchObject({ reason: 'needs_your_mac', message: expect.stringContaining('uniqlo.com') })
    expect(mock.execute).not.toHaveBeenCalled()
  })

  it('ends a Mac task when the tunnel drops, never going on from the cloud', async () => {
    const { exit } = withExit(true)
    mock.execute.mockImplementation(async (_task: unknown, ports: { alive: () => boolean }) => {
      expect(ports.alive()).toBe(true)
      exit.drop()
      expect(ports.alive()).toBe(false)
      return { status: 'cancelled', reason: 'stopped_or_deadline' }
    })
    await runClaimed(state, command({ command: 'run_task', request: task({ startUrl: 'https://resy.com/' }) }), [], 'agent', memory())
    expect(settled[0][2]).toMatchObject({ reason: 'needs_your_mac', status: 'escalate' })
    // No switch to the cloud under the task: it stays in mac (refusing) for the grace.
    expect(exit.setMode.mock.calls.filter(([m]) => m === 'cloud')).toEqual([])
  })

  it('on the cloud exit, remembers a site that blocks it and stops; a site that bans agents is never used again', async () => {
    const { markSite } = withExit(false)
    for (const [title, text, kind, reason] of [['Access Denied', 'You don\'t have permission to access "/" on this server.', 'blocked', 'needs_your_mac'],
      ['Amazon.com', 'Continued access by an unauthorized AI agent violates Amazon\'s Conditions of Use', 'agent_ban', 'never_automate']] as const) {
      settled = []
      mock.execute.mockImplementation(async (_task: unknown, ports: { decide: (o: unknown) => Promise<unknown> }) => {
        await ports.decide({ url: 'https://shop.example/x', title, text }).catch(() => {})
        return { status: 'failed', reason: 'decision_failed' }
      })
      await runClaimed(state, command({ command: 'run_task', request: task({ startUrl: 'https://shop.example/' }) }), [], 'agent', memory())
      expect(markSite).toHaveBeenLastCalledWith('https://shop.example/x', kind)
      expect(settled[0][2]).toMatchObject({ reason })
    }
    expect(decide).not.toHaveBeenCalled()
  })

  it('never starts a task on a site that forbids agents', async () => {
    withExit(true)
    await runClaimed(state, command({ command: 'run_task', request: task({ startUrl: 'https://www.amazon.com/' }) }), [], 'agent', memory({ neverAutomate: ['amazon.com'] }))
    expect(settled[0][2]).toMatchObject({ reason: 'never_automate', message: expect.stringContaining('amazon.com') })
    expect(mock.execute).not.toHaveBeenCalled()
  })
})
