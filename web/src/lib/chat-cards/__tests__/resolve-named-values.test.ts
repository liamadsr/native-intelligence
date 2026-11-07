/**
 * is_empty / is_not_empty reach resolveNamedValues with the placeholder value
 * '' (validate.ts). On an id field that '' used to be looked up as a NAME,
 * which ilike-matches every row: "unassigned actions" failed as an ambiguous
 * name, or (one member) was rewritten into "assigned to that member".
 */
import { describe, expect, it } from 'vitest'
import { resolveNamedValues, type CardScope } from '../server'
import type { VisibilityFence } from '@/lib/views/visibility-fence'

const noDb = new Proxy(
  {},
  {
    get() {
      throw new Error('no database read expected')
    },
  },
)

const scope = { supabase: noDb, workspaceId: 'ws-1', userId: 'u-1' } as unknown as CardScope
const fence = { workspaceId: 'ws-1', userId: 'u-1', memberId: 'm-1', isAdmin: false } as unknown as VisibilityFence

describe('resolveNamedValues — operators with no value', () => {
  it.each(['is_empty', 'is_not_empty'] as const)('passes %s on an id field through untouched', async (operator) => {
    const filter = { field: 'assignee_id', operator, value: '' }
    const out = await resolveNamedValues(scope, fence, 'action', [filter as never])
    expect(out).toEqual({ ok: true, value: [filter] })
  })
})
