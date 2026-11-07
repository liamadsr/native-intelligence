/**
 * Every card read takes the visibility fence as a REQUIRED argument, so no
 * card read can run unfenced on the service-role client. The @ts-expect-error
 * lines are the test: tsc fails them the moment a fence becomes optional.
 */
import { describe, expect, it } from 'vitest'
import { loadRecord, resolveNamedValues, runListQuery, SHOW_KINDS, type CardScope } from '../server'
import { readPageCard, readPageRows, showPage } from '../page-server'

describe('card reads take a fence', () => {
  it('cannot be called without one', () => {
    const scope = {} as CardScope
    const call = () => {
      // @ts-expect-error: a fence is required
      void runListQuery(scope, 'action', { filters: [] }, 10)
      // @ts-expect-error: a fence is required
      void loadRecord(scope, 'action', 'GEN-1')
      // @ts-expect-error: a fence is required
      void resolveNamedValues(scope, 'action', [])
      // @ts-expect-error: a fence is required
      void SHOW_KINDS.list(scope, { kind: 'list', title: 't', entity_type: 'action', filters: [] })
      // The page cards (P3) too.
      // @ts-expect-error: a fence is required
      void showPage(scope, { kind: 'flows', title: 't' })
      // @ts-expect-error: a fence is required
      void readPageCard(scope, { n: 1, id: 'c', kind: 'flows', title: 't' }, [])
      // @ts-expect-error: a fence is required
      void readPageRows(scope, 'flows', { place: null }, 10)
    }
    expect(typeof call).toBe('function')
    // The fence is each read's second argument.
    expect(runListQuery.length).toBe(5)
    expect(loadRecord.length).toBe(4)
    expect(resolveNamedValues.length).toBe(4)
  })
})
