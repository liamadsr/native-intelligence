import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/flows/emit-status-change', () => ({ emitStatusChange: vi.fn() }))

const { applyRemoteTaskState } = await import('../apply-remote-task-state')

type Write = { table: string; values: Record<string, unknown>; filters: Record<string, unknown> }

/**
 * The link CAS commits before the action's status write. When anything after
 * it fails, the link must be put back so the retry does not read "unchanged".
 */
function fakeDb(opts: { statusWriteFails?: boolean; stateReadFails?: boolean }) {
  const writes: Write[] = []
  const from = (table: string) => {
    const filters: Record<string, unknown> = {}
    let values: Record<string, unknown> | null = null
    const chain: Record<string, unknown> = {}
    const filter = (key: string) => (col: string, v: unknown) => {
      filters[`${key}${col}`] = v
      return chain
    }
    Object.assign(chain, {
      select: () => chain,
      eq: filter(''),
      neq: filter('neq:'),
      order: () => chain,
      limit: () => chain,
      update: (v: Record<string, unknown>) => {
        values = v
        return chain
      },
      maybeSingle: async () => {
        if (table === 'actions') {
          return {
            data: { id: 'act-1', status_id: 's-todo', team_id: 'team-1', workflow_state: { category: 'unstarted' } },
            error: null,
          }
        }
        if (table === 'workflow_state') {
          return opts.stateReadFails ? { data: null, error: { message: 'timeout' } } : { data: { id: 's-done' }, error: null }
        }
        return { data: null, error: null }
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (values) writes.push({ table, values, filters: { ...filters } })
        const failed = table === 'actions' && values && opts.statusWriteFails
        // The link CAS `.select('id')` resolves through here too.
        const data = table === 'action_external_task' && 'neq:completed' in filters ? [{ id: 'link-1' }] : null
        return Promise.resolve({ data, error: failed ? { message: 'deadlock' } : null }).then(resolve)
      },
    })
    return chain
  }
  return { client: { from } as never, writes }
}

const link = { id: 'link-1', action_id: 'act-1', external_id: 'T1', completed: false }
const run = (client: never) =>
  applyRemoteTaskState({ supabase: client, workspaceId: 'ws-1', actorUserId: 'u-1', link, remoteCompleted: true })

describe('applyRemoteTaskState — a failure after the link CAS rolls the link back', () => {
  it('a failed status write restores completed=false on the link, then throws', async () => {
    const { client, writes } = fakeDb({ statusWriteFails: true })
    await expect(run(client)).rejects.toMatchObject({ message: 'deadlock' })
    const linkWrites = writes.filter((w) => w.table === 'action_external_task')
    expect(linkWrites.map((w) => w.values.completed)).toEqual([true, false])
    expect(linkWrites[1].filters).toMatchObject({ id: 'link-1', completed: true })
  })

  it('a failed target-state read also rolls back instead of reporting no_target_state', async () => {
    const { client, writes } = fakeDb({ stateReadFails: true })
    await expect(run(client)).rejects.toMatchObject({ message: 'timeout' })
    const linkWrites = writes.filter((w) => w.table === 'action_external_task')
    expect(linkWrites.map((w) => w.values.completed)).toEqual([true, false])
    expect(writes.some((w) => w.table === 'actions')).toBe(false)
  })

  it('a clean apply writes the link once and moves the action', async () => {
    const { client, writes } = fakeDb({})
    expect(await run(client)).toMatchObject({ outcome: 'completed', toStatusId: 's-done' })
    expect(writes.filter((w) => w.table === 'action_external_task')).toHaveLength(1)
  })
})
