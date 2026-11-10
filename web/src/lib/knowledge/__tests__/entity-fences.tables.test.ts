/**
 * The table fences (migration 520): a table through the database's own rule
 * (visible_data_table_ids, one call), a row through its table. Fail closed.
 */
import { describe, expect, it } from 'vitest'
import { hiddenPrivateRefs, visiblePrivateKindIds } from '../entity-fences'
import { fakeTablesDb } from '@/lib/tables/__tests__/fake-tables-db'

const WS = 'ws-1'
const OPEN = '11111111-1111-4111-8111-111111111111'
const PRIVATE = '22222222-2222-4222-8222-222222222222'
const OTHER_WS = '33333333-3333-4333-8333-333333333333'

function db(fail = false) {
  return fakeTablesDb(
    {
      data_table: [
        { id: OPEN, workspace_id: WS },
        { id: PRIVATE, workspace_id: WS },
        { id: OTHER_WS, workspace_id: 'ws-2' },
      ],
      data_row: [
        { id: 'row-open', workspace_id: WS, table_id: OPEN },
        { id: 'row-private', workspace_id: WS, table_id: PRIVATE },
      ],
    },
    (name, args) => {
      if (fail) return { data: null, error: { message: 'boom' } }
      expect(name).toBe('visible_data_table_ids')
      // The reader sees the open table and the other workspace's, never the private one.
      const ids = (args.p_ids as string[]).filter((id) => id !== PRIVATE)
      return { data: args.p_user_id === 'u-1' ? ids : [], error: null }
    },
  )
}

describe('table fences', () => {
  it('a table: the rule’s answer, inside the workspace asked about', async () => {
    const f = db()
    expect([...(await visiblePrivateKindIds(f.client, 'data_table', 'u-1', [OPEN, PRIVATE, OTHER_WS]))].sort()).toEqual([OPEN, OTHER_WS].sort())
    expect([...(await visiblePrivateKindIds(f.client, 'data_table', 'u-1', [OPEN, PRIVATE, OTHER_WS], WS))]).toEqual([OPEN])
    expect(f.rpcCalls).toHaveLength(2)
  })

  it('a row: whoever may read its table', async () => {
    const f = db()
    expect([...(await visiblePrivateKindIds(f.client, 'data_row', 'u-1', ['row-open', 'row-private'], WS))]).toEqual(['row-open'])
    const hidden = await hiddenPrivateRefs(f.client, [{ type: 'data_row', id: 'row-private' }, { type: 'data_table', id: OPEN }, { type: 'project', id: 'p' }], 'u-1', WS)
    expect([...hidden]).toEqual(['data_row:row-private'])
  })

  it('fails closed: no user, another user, a failed read', async () => {
    expect((await visiblePrivateKindIds(db().client, 'data_table', null, [OPEN])).size).toBe(0)
    expect((await visiblePrivateKindIds(db().client, 'data_table', 'u-2', [OPEN])).size).toBe(0)
    expect((await visiblePrivateKindIds(db(true).client, 'data_row', 'u-1', ['row-open'])).size).toBe(0)
  })
})
