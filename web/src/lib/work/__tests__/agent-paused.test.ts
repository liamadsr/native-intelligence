/**
 * The one kill switch (A5 slice 5): `workspace.settings.agent_autonomy.mode`
 * 'off' pauses the agent. A failed read fails OPEN with a log (see the
 * header of agent-paused.ts for why); the per-tick cache reads each workspace
 * once.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const { expirePendingApprovals } = vi.hoisted(() => ({ expirePendingApprovals: vi.fn(async () => {}) }))
vi.mock('@/lib/safety/approvals', () => ({ expirePendingApprovals }))
import {
  agentPausedCache,
  checkAgentPaused,
  helperStartPaused,
  isAgentPaused,
  readAgentPausedState,
  routerPaused,
  stopPausedWorkspaceExtras,
} from '../agent-paused'

type Row = { settings: unknown } | null

function db(rows: Record<string, Row>, opts: { error?: string; throws?: boolean } = {}) {
  const reads: string[] = []
  const client = {
    from(table: string) {
      expect(table).toBe('workspace')
      let id = ''
      const c = {
        select: (cols: string) => (expect(cols).toBe('settings'), c),
        eq: (k: string, v: string) => (expect(k).toBe('id'), (id = v), c),
        maybeSingle: async () => {
          reads.push(id)
          if (opts.throws) throw new Error('socket hang up')
          if (opts.error) return { data: null, error: { message: opts.error } }
          return { data: rows[id] ?? null, error: null }
        },
      }
      return c
    },
  }
  return { client: client as unknown as SupabaseClient, reads }
}

const off = { settings: { agent_autonomy: { mode: 'off' } } }
const propose = { settings: { agent_autonomy: { mode: 'propose' } } }
const attempt = { settings: { agent_autonomy: { mode: 'attempt' } } }

afterEach(() => vi.restoreAllMocks())

describe('readAgentPausedState', () => {
  it("is 'paused' only when mode is 'off'", async () => {
    const { client } = db({ a: off, b: propose, c: attempt, d: { settings: {} }, e: { settings: null } })
    expect(await readAgentPausedState(client, 'a')).toBe('paused')
    expect(await readAgentPausedState(client, 'b')).toBe('active')
    expect(await readAgentPausedState(client, 'c')).toBe('active')
    expect(await readAgentPausedState(client, 'd')).toBe('active')
    expect(await readAgentPausedState(client, 'e')).toBe('active')
    // A missing row is the default policy: not paused.
    expect(await readAgentPausedState(client, 'missing')).toBe('active')
  })

  it("is 'unknown' on a read error or a throw, never throwing itself", async () => {
    expect(await readAgentPausedState(db({}, { error: 'boom' }).client, 'a')).toBe('unknown')
    expect(await readAgentPausedState(db({}, { throws: true }).client, 'a')).toBe('unknown')
  })
})

describe('isAgentPaused / checkAgentPaused', () => {
  it('a failed read fails open and logs which door could not tell', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await isAgentPaused(db({}, { error: 'boom' }).client, 'ws-1', 'router')).toBe(false)
    expect(warn).toHaveBeenCalledWith('[agent-paused] could not read the kill switch; continuing', { workspaceId: 'ws-1', door: 'router' })
  })

  it('checkAgentPaused logs a refusal with its door', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    expect(await checkAgentPaused(db({ 'ws-1': off }).client, 'ws-1', 'helper_start')).toBe(true)
    expect(info).toHaveBeenCalledWith('[agent-paused] refused', { workspaceId: 'ws-1', door: 'helper_start' })
    info.mockClear()
    expect(await checkAgentPaused(db({ 'ws-1': propose }).client, 'ws-1', 'helper_start')).toBe(false)
    expect(info).not.toHaveBeenCalled()
  })
})

describe('the A4 / A6 entry points', () => {
  it('helperStartPaused and routerPaused ask the switch under their own door', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { client } = db({ off, on: propose })
    expect(await helperStartPaused(client, 'off')).toBe(true)
    expect(await routerPaused(client, 'off')).toBe(true)
    expect(await helperStartPaused(client, 'on')).toBe(false)
    expect(await routerPaused(client, 'on')).toBe(false)
    expect(info.mock.calls.map((c) => (c[1] as { door: string }).door)).toEqual(['helper_start', 'router'])
  })
})

describe('agentPausedCache', () => {
  it('reads each workspace once per tick', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { client, reads } = db({ a: off, b: propose })
    const isPaused = agentPausedCache(client, 'email_pass')
    expect(await Promise.all([isPaused('a'), isPaused('b'), isPaused('a'), isPaused('a')])).toEqual([true, false, true, true])
    expect(reads.sort()).toEqual(['a', 'b'])
  })
})

describe('failing closed where it spends money (A6 review)', () => {
  it('the router and a fail-closed cache read an unreadable switch as paused; the default doors still fail open', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = db({}, { error: 'boom' }).client
    expect(await routerPaused(broken, 'ws-1')).toBe(true)
    expect(await checkAgentPaused(broken, 'ws-1', 'email_pass', { failClosed: true })).toBe(true)
    expect(await agentPausedCache(broken, 'email_pass', { failClosed: true })('ws-1')).toBe(true)
    expect(await helperStartPaused(broken, 'ws-1')).toBe(false)
    expect(await agentPausedCache(broken, 'flow_dispatch')('ws-1')).toBe(false)
  })
})

describe('stopPausedWorkspaceExtras (the off fan-out)', () => {
  it('expires the workspace’s pending approvals; loops are refused at their next tool call', async () => {
    const { client } = db({})
    expect(await stopPausedWorkspaceExtras(client, 'ws-1')).toEqual({
      loopSessions: 'refused_at_next_tool_call',
      approvals: 'expired',
    })
    expect(expirePendingApprovals).toHaveBeenCalledWith(client, 'ws-1')
  })
})
