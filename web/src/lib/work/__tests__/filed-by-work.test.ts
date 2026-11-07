/**
 * entitiesFiledByWork: what a unit of work filed itself (its created /
 * proposed touches), which the promotion guard reads so an unattended run
 * never confirms its own suggestion. Fails closed.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import { entitiesFiledByWork } from '../touch'

const JOB = '0d0d0d0d-0000-4000-8000-000000000001'
const OTHER_JOB = '0d0d0d0d-0000-4000-8000-000000000002'
const A = '0e0e0e0e-0000-4000-8000-00000000000a'
const B = '0e0e0e0e-0000-4000-8000-00000000000b'
const C = '0e0e0e0e-0000-4000-8000-00000000000c'

describe('entitiesFiledByWork', () => {
  it('answers the ids this job created or proposed, not what it only read or another job filed', async () => {
    const fake = makeFakeSupabase()
    fake.seed('work_touch', [
      { work_item_id: JOB, entity_id: A, verb: 'created' },
      { work_item_id: JOB, entity_id: B, verb: 'read' },
      { work_item_id: OTHER_JOB, entity_id: C, verb: 'proposed' },
    ])
    expect(await entitiesFiledByWork(fake as never, { workItemId: JOB, ids: [A.toUpperCase(), B, C, 'not-a-uuid'] })).toEqual(new Set([A]))
  })

  it('fails closed: a read that errors answers every id, so the confirm is left for the person', async () => {
    const broken = {
      from: () => {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.in = () => b
        b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'down' } })
        return b
      },
    }
    expect(await entitiesFiledByWork(broken as never, { workItemId: JOB, ids: [A, B] })).toEqual(new Set([A, B]))
  })
})
