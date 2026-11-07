/**
 * Every errcode the merge RPCs raise (migration 402) lands on a fixed HTTP
 * answer, and no raw Postgres message that interpolates workspace ids reaches
 * the body. The two plan errors carry their (id-free) reason, so the dialog
 * can say which team is the problem.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mergeRpcErrorResponse } from '../errors'

const SRC = '11111111-1111-4111-8111-111111111111'
const RAW = `workspace ${SRC} has 3 live captures`

async function read(res: Response) {
  const json = (await res.json()) as { error: string; code?: string; details?: unknown }
  return { status: res.status, ...json }
}

describe('mergeRpcErrorResponse', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['P0002', 404, 'NOT_FOUND'],
    ['42501', 403, 'FORBIDDEN'],
    ['22023', 400, 'BAD_REQUEST'],
    ['22P02', 400, 'BAD_REQUEST'],
    ['P0007', 409, 'SOURCE_BUSY'],
    ['P0009', 409, 'DRIFT'],
    ['P0010', 409, 'MERGE_IN_PROGRESS'],
    ['P0011', 503, 'MERGE_EXPIRED'],
    ['P0012', 503, 'MERGE_INTERRUPTED'],
    ['P0013', 503, 'MERGE_RUNNER_UNAVAILABLE'],
    ['P0008', 500, 'MERGE_ASSERTION'],
    ['23505', 409, 'MERGE_CONFLICT'],
    ['40P01', 409, 'MERGE_RETRY'],
    ['40001', 409, 'MERGE_RETRY'],
    ['55P03', 409, 'MERGE_RETRY'],
    ['57014', 503, 'MERGE_TIMEOUT'],
    ['PGRST202', 503, 'SCHEMA_CACHE_STALE'],
  ])('%s → %i %s, with a fixed message', async (code, status, apiCode) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await read(mergeRpcErrorResponse('merge_workspace', { code, message: RAW }))
    expect(out.status).toBe(status)
    expect(out.code).toBe(apiCode)
    expect(out.error).not.toContain(SRC)
    expect(out.error.length).toBeGreaterThan(0)
    expect(out.details).toBeUndefined()
  })

  it('the plan errors carry their reason (fixed text and the typed slug or prefix, never an id)', async () => {
    const taken = await read(mergeRpcErrorResponse('merge_workspace_preflight', { code: 'P0006', message: 'team prefix "COH" is already taken in the destination' }))
    expect(taken).toMatchObject({ status: 409, code: 'PLAN_INVALID', details: { reason: 'team prefix "COH" is already taken in the destination' } })
    const noDefault = await read(mergeRpcErrorResponse('merge_workspace_preflight', { code: 'P0003', message: 'destination team has no default workflow state' }))
    expect(noDefault).toMatchObject({ status: 400, details: { reason: 'destination team has no default workflow state' } })
  })

  it('a PostgREST schema cache that does not know the function yet is a retryable 503, with or without the code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const message = 'Could not find the function public.merge_workspace_preflight(p_actor, p_destination, p_plan, p_source) in the schema cache'
    for (const code of ['PGRST202', null, '']) {
      const out = await read(mergeRpcErrorResponse('merge_workspace_preflight', { code, message }))
      expect(out, String(code)).toMatchObject({ status: 503, code: 'SCHEMA_CACHE_STALE' })
    }
  })

  it('anything else is a plain 500 named after the step, logged with its code', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pre = await read(mergeRpcErrorResponse('merge_workspace_preflight', { code: 'XX000', message: RAW }))
    const run = await read(mergeRpcErrorResponse('merge_workspace', { code: 'XX000', message: RAW }))
    expect(pre.status).toBe(500)
    expect(pre.error).toBe('Preflight failed')
    expect(run.error).toBe('Merge failed')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('merge_workspace'), 'XX000', RAW)
  })

  it('whatever rolled back says nothing was changed; a preflight timeout is worded as one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const code of ['57014', 'P0008', 'P0009', '23505', '40P01']) {
      const out = await read(mergeRpcErrorResponse('merge_workspace', { code, message: RAW }))
      expect(out.error, code).toMatch(/nothing was changed/i)
    }
    const pre = await read(mergeRpcErrorResponse('merge_workspace_preflight', { code: '57014', message: RAW }))
    expect(pre.error).toMatch(/preflight took too long/i)
    expect(pre.error).not.toMatch(/merge took too long/i)
  })
})
