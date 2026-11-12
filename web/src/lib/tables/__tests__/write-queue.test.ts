/**
 * The grid's write queue (../write-queue.ts): one batch in flight, what
 * queued meanwhile merged into the next, the version chained, a 409 caught
 * up and rebased (their cells kept), and a refusal handing the cells back.
 */
import { describe, expect, it, vi } from 'vitest'
import { createWriteQueue, type SendResult, type WriteQueueDeps } from '../write-queue'
import type { DataOp } from '../types'

const R1 = '11111111-1111-4111-8111-111111111111'
const R2 = '22222222-2222-4222-8222-222222222222'
const edit = (row: string, values: Record<string, unknown>): DataOp => ({ op: 'update_row', row_id: row, values: values as never })

function setup(answers: Array<(base: number, ops: DataOp[]) => SendResult>, overrides: Partial<WriteQueueDeps> = {}) {
  let version = 4
  const sent: Array<{ base: number; ops: DataOp[] }> = []
  let release: (() => void) | null = null
  const deps: WriteQueueDeps = {
    send: vi.fn(async (base: number, ops: DataOp[]) => {
      sent.push({ base, ops })
      // The first send waits until the test releases it (a batch in flight).
      if (sent.length === 1) await new Promise<void>((r) => (release = r))
      const answer = answers.shift() ?? ((b: number) => ({ ok: true as const, version: b + 1, change_id: `ch-${b + 1}` }))
      return answer(base, ops)
    }),
    version: () => version,
    setVersion: (v) => {
      version = v
    },
    catchUp: vi.fn(async () => null),
    onApplied: vi.fn(),
    onRefused: vi.fn(),
    onDropped: vi.fn(),
    onIdle: vi.fn(),
    ...overrides,
  }
  const queue = createWriteQueue(deps)
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  return { queue, deps, sent, flush, release: () => release?.(), version: () => version }
}

describe('createWriteQueue', () => {
  it('sends one batch at a time and merges what queued meanwhile into the next, on the new version', async () => {
    const s = setup([])
    s.queue.push({ ops: [edit(R1, { qty: 1 })], cells: [] })
    await s.flush()
    expect(s.sent).toHaveLength(1)
    s.queue.push({ ops: [edit(R1, { qty: 2 })], cells: [] })
    s.queue.push({ ops: [edit(R2, { qty: 3 })], cells: [] })
    await s.flush()
    expect(s.sent).toHaveLength(1)
    s.release()
    await s.queue.settled()
    expect(s.sent.map((x) => [x.base, x.ops.length])).toEqual([
      [4, 1],
      [5, 2],
    ])
    expect(s.version()).toBe(6)
    expect(s.deps.onApplied).toHaveBeenCalledTimes(2)
    expect(s.deps.onIdle).toHaveBeenCalled()
  })

  it('pushes made in one task go as one batch', async () => {
    const s = setup([])
    s.queue.push({ ops: [edit(R1, { qty: 1 })], cells: [] })
    s.queue.push({ ops: [edit(R2, { qty: 2 })], cells: [] })
    await s.flush()
    s.release()
    await s.queue.settled()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].ops).toHaveLength(2)
  })

  it('on a 409 catches up, keeps their cells, and sends the rest on their version', async () => {
    const catchUp = vi.fn(async () => ({
      version: 7,
      changes: [{ changes: [{ op: 'update_row' as const, row_id: R1, fields: { 'values.qty': { from: null, to: 9 } } }] }],
    }))
    const s = setup([() => ({ ok: false, status: 409, error: 'changed', version: 7 })], { catchUp })
    s.queue.push({ ops: [edit(R1, { qty: 1, notes: 'mine' }), edit(R2, { qty: 2 })], cells: [] })
    await s.flush()
    s.release()
    await s.queue.settled()
    expect(catchUp).toHaveBeenCalledWith(4)
    expect(s.sent).toHaveLength(2)
    expect(s.sent[1].base).toBe(7)
    expect(s.sent[1].ops).toEqual([edit(R1, { notes: 'mine' }), edit(R2, { qty: 2 })])
    expect(s.deps.onDropped).toHaveBeenCalledWith(1)
    expect(s.version()).toBe(8)
    expect(s.deps.onRefused).not.toHaveBeenCalled()
  })

  it('sends nothing more when everything in the batch was changed by someone else', async () => {
    const catchUp = vi.fn(async () => ({ version: 5, changes: [{ changes: [{ op: 'archive_rows' as const, row_ids: [R1] }] }] }))
    const s = setup([() => ({ ok: false, status: 409, error: 'changed' })], { catchUp })
    s.queue.push({ ops: [edit(R1, { qty: 1 })], cells: [] })
    await s.flush()
    s.release()
    await s.queue.settled()
    expect(s.sent).toHaveLength(1)
    expect(s.deps.onDropped).toHaveBeenCalledWith(1)
  })

  it('refuses the batch (its cells handed back) when it can’t catch up, or when the server says no', async () => {
    const cells = [{ rowId: R1, key: 'qty', from: null, to: 1 }]
    const s = setup([() => ({ ok: false, status: 409, error: 'changed' })])
    s.queue.push({ ops: [edit(R1, { qty: 1 })], cells })
    await s.flush()
    s.release()
    await s.queue.settled()
    expect(s.deps.onRefused).toHaveBeenCalledWith(expect.stringContaining('changed while you were editing'), { ops: [edit(R1, { qty: 1 })], cells })

    const t = setup([() => ({ ok: false, status: 400, error: 'Client links a record that isn’t one you can link to.' })])
    t.queue.push({ ops: [edit(R1, { qty: 1 })], cells })
    await t.flush()
    t.release()
    await t.queue.settled()
    expect(t.deps.onRefused).toHaveBeenCalledWith('Client links a record that isn’t one you can link to.', expect.objectContaining({ cells }))
    expect(t.version()).toBe(4)
  })

  it('treats a network failure as a refusal', async () => {
    const s = setup([])
    ;(s.deps.send as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('offline')
    })
    s.queue.push({ ops: [edit(R1, { qty: 1 })], cells: [] })
    await s.queue.settled()
    expect(s.deps.onRefused).toHaveBeenCalledWith('offline', expect.anything())
  })
})
