import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The work-agent's delegate_work tool (Part 5 row 13). Invariants:
 *   1. it gates on `approval` so every call PAUSES the turn (input.requested):
 *      the server decides the handoff while the turn is paused, never the tool;
 *   2. the schema takes a role, a brief with a task, and optional expects and
 *      resources, and rejects a handoff with no task;
 *   3. execute creates nothing: it FETCHES what happened to its own call (by
 *      ctx.callId) and returns it as the tool result, with a note saying how
 *      to use it.
 */
const h = vi.hoisted(() => ({ fetchDelegationResult: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ status: 'completed' })) }))
vi.mock('../spec-client.js', () => ({
  fetchDelegationResult: h.fetchDelegationResult,
  runTokenFromAuth: (auth: { token?: string } | undefined) => auth?.token ?? '',
}))

import delegateWork from '../../tools/delegate_work'

type Tool = {
  approval?: unknown
  inputSchema: { safeParse: (v: unknown) => { success: boolean } }
  execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>>
}
const tool = delegateWork as unknown as Tool
const ctx = { callId: 'call-7', session: { auth: { token: 'run.token' } } }

beforeEach(() => h.fetchDelegationResult.mockClear())

describe('work-agent delegate_work', () => {
  it('gates on approval, so the turn pauses before anything runs', () => {
    expect(tool.approval).toBeDefined()
  })

  it('takes a role and a brief with a task; expects and resources are optional', () => {
    expect(tool.inputSchema.safeParse({ role: 'researcher', brief: { task: 'Find the price.' } }).success).toBe(true)
    expect(
      tool.inputSchema.safeParse({
        role: 'writer',
        brief: { task: 'Write it up.', context: 'ctx', hand_back: 'a doc' },
        expects: [{ type: 'document', min: 1 }],
        resources: [{ type: 'capture', id: 'cap-1' }],
      }).success,
    ).toBe(true)
    expect(tool.inputSchema.safeParse({ role: 'researcher', brief: {} }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ role: 'intern', brief: { task: 'x' } }).success).toBe(false)
  })

  it('execute fetches its own call’s result and returns it with a note', async () => {
    h.fetchDelegationResult.mockResolvedValueOnce({ status: 'completed', header: 'Researcher finished: 1 document' })
    const out = await tool.execute({ role: 'researcher', brief: { task: 'x' } }, ctx)
    expect(h.fetchDelegationResult).toHaveBeenCalledWith('run.token', 'call-7')
    expect(out).toMatchObject({ status: 'completed', header: 'Researcher finished: 1 document' })
    expect(String(out.note)).toContain('The teammate finished')
  })

  it('a refusal, a failure and an unreadable result each carry their own note', async () => {
    h.fetchDelegationResult.mockResolvedValueOnce({ status: 'refused' })
    expect(String((await tool.execute({}, ctx)).note)).toContain('The handoff was refused')
    h.fetchDelegationResult.mockResolvedValueOnce({ status: 'failed' })
    expect(String((await tool.execute({}, ctx)).note)).toContain('did not finish')
    h.fetchDelegationResult.mockResolvedValueOnce({ error: 'down' })
    expect(String((await tool.execute({}, ctx)).note)).toContain('could not be read')
  })
})
