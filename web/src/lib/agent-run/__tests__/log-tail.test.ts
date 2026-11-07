/**
 * The cancel signal the eve watchers (coding + work) read off agent_run.
 *
 * Both reads must report "stop" for 'canceling' AND 'canceled': agentRunCancel
 * settles one into the other within seconds, and a watcher that only knew
 * 'canceling' would keep a canceled run's stream (and its session) going.
 * readAgentRunCanceling is the ONLY read a quiet run gets (the empty-buffer
 * flush), so it is pinned directly here.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/work/agent-run-mirror', () => ({ beatAgentRunWork: vi.fn(async () => {}) }))

import { readAgentRunCanceling, appendAgentRunLog } from '../log-tail'

/**
 * `resolvedError` is how supabase-js ACTUALLY fails a read: postgrest-js resolves
 * `{ data: null, error }` on a network or PostgREST error instead of throwing.
 * `throwOnRead` covers a throw from anything else in the call.
 */
function supabaseWithRow(
  row: Record<string, unknown> | null,
  opts: { throwOnRead?: boolean; resolvedError?: boolean } = {},
) {
  const updates: Record<string, unknown>[] = []
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => {
      if (opts.throwOnRead) throw new Error('network')
      if (opts.resolvedError) {
        return { data: null, error: { message: 'TypeError: fetch failed', details: '', hint: '', code: '' } }
      }
      return { data: row, error: null }
    },
    update: (patch: Record<string, unknown>) => {
      updates.push(patch)
      return { eq: async () => ({ error: null }) }
    },
  }
  return { supabase: { from: () => chain } as never, updates }
}

const ARGS = { agentRunId: 'run-1', workspaceId: 'ws-1' }

describe('readAgentRunCanceling', () => {
  it.each([
    ['canceling', true],
    ['canceled', true],
    ['queued', false],
    ['running', false],
    ['pr_open', false],
    ['completed', false],
    ['failed', false],
  ])("status '%s' → %s", async (status, expected) => {
    const { supabase } = supabaseWithRow({ status })
    expect(await readAgentRunCanceling(supabase, ARGS)).toBe(expected)
  })

  it('a missing row reads as stop (delete race)', async () => {
    const { supabase } = supabaseWithRow(null)
    expect(await readAgentRunCanceling(supabase, ARGS)).toBe(true)
  })

  it('a transient read error does not stop a healthy run (supabase-js resolves { data: null, error })', async () => {
    const { supabase } = supabaseWithRow({ status: 'running' }, { resolvedError: true })
    expect(await readAgentRunCanceling(supabase, ARGS)).toBe(false)
  })

  it('a thrown read error does not stop a healthy run either', async () => {
    const { supabase } = supabaseWithRow({ status: 'running' }, { throwOnRead: true })
    expect(await readAgentRunCanceling(supabase, ARGS)).toBe(false)
  })
})

describe('appendAgentRunLog cancel signal', () => {
  it.each([
    ['canceling', true],
    ['canceled', true],
    ['running', false],
  ])("status '%s' → canceling %s", async (status, expected) => {
    const { supabase } = supabaseWithRow({ status, log_tail: '' })
    expect(await appendAgentRunLog(supabase, { ...ARGS, text: 'x' })).toEqual({ canceling: expected })
  })

  it('a missing row reads as stop (delete race) and writes nothing', async () => {
    const { supabase, updates } = supabaseWithRow(null)
    expect(await appendAgentRunLog(supabase, { ...ARGS, text: 'x' })).toEqual({ canceling: true })
    expect(updates).toEqual([])
  })

  it('a resolved read error is NOT a missing row: canceling false, nothing written', async () => {
    const { supabase, updates } = supabaseWithRow({ status: 'running', log_tail: '' }, { resolvedError: true })
    expect(await appendAgentRunLog(supabase, { ...ARGS, text: 'x' })).toEqual({ canceling: false })
    expect(updates).toEqual([])
  })

  it('a thrown read error: canceling false', async () => {
    const { supabase } = supabaseWithRow({ status: 'running', log_tail: '' }, { throwOnRead: true })
    expect(await appendAgentRunLog(supabase, { ...ARGS, text: 'x' })).toEqual({ canceling: false })
  })
})
