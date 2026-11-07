/**
 * The eval capture cleanup both DELETE routes and both bulk branches call.
 *
 * Two halves, both of which are invisible from any screen when they go wrong:
 *
 *   - `collectTrialCaptureIds` is the one thing that ever names a per-trial
 *     CLONE capture. The composite FK points capture → trial, so a suite or
 *     case delete cascades `eval_trial` away and a clone that was not collected
 *     first becomes an unreachable `is_eval` row holding a full synthetic
 *     transcript, forever.
 *   - `deleteEvalCaptures`'s guards are on the DELETE itself, not on a
 *     preceding read: `is_eval = true` is what makes a mis-seeded case pointing
 *     at a REAL capture unable to take one down with it.
 */
import { describe, it, expect, vi } from 'vitest'
import { makeFakeSupabase, filterArgs, findQuery } from '@/lib/evals/__tests__/fake-supabase'
import { collectTrialCaptureIds, deleteEvalCaptures } from '../delete-captures'

const WS = 'ws-1'

describe('collectTrialCaptureIds', () => {
  it('returns every trial capture id for the given cases, workspace-scoped', async () => {
    const { client, queries } = makeFakeSupabase(() => ({
      data: [{ capture_id: 'clone-1' }, { capture_id: 'clone-2' }],
    }))
    const ids = await collectTrialCaptureIds(client, WS, ['case-1', 'case-2'])
    expect(ids).toEqual(['clone-1', 'clone-2'])

    const q = findQuery(queries, 'eval_trial', 'select')!
    expect(filterArgs(q, 'in')).toContainEqual(['case_id', ['case-1', 'case-2']])
    expect(filterArgs(q, 'eq')).toContainEqual(['workspace_id', WS])
  })

  it('reads nothing at all for an empty case list', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: [] }))
    expect(await collectTrialCaptureIds(client, WS, [])).toEqual([])
    expect(queries).toHaveLength(0)
  })

  // A trial that errored before its clone landed carries a null capture_id.
  it('drops null capture ids rather than handing them to the delete', async () => {
    const { client } = makeFakeSupabase(() => ({
      data: [{ capture_id: null }, { capture_id: 'clone-1' }],
    }))
    expect(await collectTrialCaptureIds(client, WS, ['case-1'])).toEqual(['clone-1'])
  })

  // Some clones left behind is the status quo, not a reason to fail a delete
  // whose visible half already succeeded.
  it('returns an empty list when the read fails, rather than throwing', async () => {
    const { client } = makeFakeSupabase(() => ({ data: null, error: { message: 'timeout' } }))
    expect(await collectTrialCaptureIds(client, WS, ['case-1'])).toEqual([])
  })
})

describe('deleteEvalCaptures', () => {
  it('guards the DELETE itself with is_eval and the workspace', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ error: null }))
    await deleteEvalCaptures(client, WS, ['cap-1', 'clone-1'])

    const q = findQuery(queries, 'captures', 'delete')!
    expect(filterArgs(q, 'in')).toContainEqual(['id', ['cap-1', 'clone-1']])
    expect(filterArgs(q, 'eq')).toContainEqual(['workspace_id', WS])
    expect(filterArgs(q, 'eq')).toContainEqual(['is_eval', true])
  })

  it('issues no delete for an empty id list', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ error: null }))
    await deleteEvalCaptures(client, WS, [])
    expect(queries).toHaveLength(0)
  })
})

describe('deleteEvalCaptures — trial goals', () => {
  // A trial's meeting_goal keeps its row when the capture goes (capture_id is
  // ON DELETE SET NULL), so it is removed by the synthetic key only a trial
  // writes.
  it('removes each clone goal by its capture:<id> key, workspace-scoped', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ error: null }))
    await deleteEvalCaptures(client, WS, ['cap-1', 'clone-1'])
    const q = findQuery(queries, 'meeting_goal', 'delete')!
    expect(q).toBeTruthy()
    expect(filterArgs(q, 'eq')).toContainEqual(['workspace_id', WS])
    expect(filterArgs(q, 'in')).toContainEqual(['calendar_event_id', ['capture:cap-1', 'capture:clone-1']])
  })

  it('still deletes the captures when the goal cleanup fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client, queries } = makeFakeSupabase((q) =>
      q.table === 'meeting_goal' ? { error: { message: 'boom' } } : { error: null },
    )
    await deleteEvalCaptures(client, WS, ['clone-1'])
    expect(findQuery(queries, 'captures', 'delete')).toBeTruthy()
    errors.mockRestore()
  })
})
