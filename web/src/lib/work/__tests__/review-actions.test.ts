/**
 * reviewActionIdsForWork: the actions a run is working, read off its own
 * ledger row, so an agent completing one moves it to review (decision 9):
 * its source action, the action that fired its loop, and its root row's.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import { reviewActionIdsForWork } from '../review-actions'

describe('reviewActionIdsForWork', () => {
  it('a work run on an action: its source action', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [{ id: 'job-1', root_id: 'job-1', source: { agent_run_id: 'run-1', action_id: 'act-1' } }])
    expect(await reviewActionIdsForWork(fake as never, 'job-1')).toEqual(['act-1'])
  })

  it('a loop fired by an action’s status change: the action that fired it', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [{ id: 'job-f', root_id: null, source: { flow_id: 'flow-1', entity_type: 'action', entity_id: 'act-trigger' } }])
    expect(await reviewActionIdsForWork(fake as never, 'job-f')).toEqual(['act-trigger'])
  })

  it('a delegated child: the parent’s action, off its root row', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      { id: 'job-root', root_id: 'job-root', source: { action_id: 'act-parent' } },
      { id: 'job-child', root_id: 'job-root', parent_id: 'job-root', source: { agent_run_id: 'run-child' } },
    ])
    expect(await reviewActionIdsForWork(fake as never, 'job-child')).toEqual(['act-parent'])
  })

  it('a capture-fired loop or no ledger row: nothing', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [{ id: 'job-c', source: { entity_type: 'capture', entity_id: 'cap-1' } }])
    expect(await reviewActionIdsForWork(fake as never, 'job-c')).toEqual([])
    expect(await reviewActionIdsForWork(fake as never, null)).toEqual([])
  })
})
