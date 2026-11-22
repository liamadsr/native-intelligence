/**
 * The agent's canvas tools and a canvas shared with the person (migration
 * 688, docs/plans/record-sharing.md, Phase 2). The tools ask the database's
 * own rule (canvas_visible_to, canvas_editable_by, canvas_visible_ungranted),
 * stubbed here as 688 answers it, and add the turn's own limits:
 *   - a guest's or a linked agent's turn opens nothing a grant opens (519);
 *   - only a turn that may use an edit grant edits through one (tables' rule);
 *   - a view grant never edits.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { createCanvasTools } from '../canvas'

const WS = '11111111-1111-4111-8111-111111111111'
const ME = 'u-ben'
const SHARED = '44444444-4444-4444-8444-000000000002'

type Answers = { visible: boolean; ungranted: boolean; editable: boolean }

function setup(answers: Answers) {
  const tables = {
    member: [{ id: 'm-ben', workspace_id: WS, user_id: ME, role: 'member', display_name: 'Ben Ortiz' }],
    canvas: [{ id: SHARED, workspace_id: WS, title: 'Launch board', visibility: 'private', owner_member_id: 'm-ana', archived_at: null }],
    canvas_item: [] as Record<string, unknown>[],
    canvas_comment: [] as Record<string, unknown>[],
  }
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (args.p_canvas_id !== SHARED || args.p_user_id !== ME) return { data: false, error: null }
    if (name === 'canvas_visible_to') return { data: answers.visible, error: null }
    if (name === 'canvas_visible_ungranted') return { data: answers.ungranted, error: null }
    if (name === 'canvas_editable_by') return { data: answers.editable, error: null }
    return { data: null, error: { message: `no rpc ${name}` } }
  })
  const db = Object.assign(memoryDb(tables), { rpc })
  const tools = (editGrants: boolean, omitGrants: boolean) => createCanvasTools(ME, db, WS, false, 'session', editGrants, omitGrants) as Record<string, unknown>
  const run = async (t: Record<string, unknown>, name: string, input: Record<string, unknown>) =>
    (await (t[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, {})) as Record<string, unknown>
  return { tools, run, rpc, tables }
}

const move = { canvas_id: SHARED, operations: [{ op: 'create_text', x: 0, y: 0, text: 'hello' }] }

describe('the canvas tools and a shared canvas (688)', () => {
  it('a view grant reads it (can_edit false) and never edits it', async () => {
    const { tools, run, tables } = setup({ visible: true, ungranted: false, editable: false })
    const read = await run(tools(true, false), 'read_canvas', { canvas_id: SHARED })
    expect(read.success, JSON.stringify(read)).toBe(true)
    expect((read.canvas as { can_edit: boolean }).can_edit).toBe(false)
    const edit = await run(tools(true, false), 'edit_canvas', move)
    expect(edit.success).toBe(false)
    expect(String(edit.error)).toContain('can view that canvas but not change it')
    expect(tables.canvas_item).toEqual([])
  })

  it('an edit grant edits it only on a turn that may use one', async () => {
    const { tools, run } = setup({ visible: true, ungranted: false, editable: true })
    const held = await run(tools(false, false), 'edit_canvas', move)
    expect(held.success).toBe(false)
    expect(String(held.error)).toContain('not change it')
    const read = await run(tools(true, false), 'read_canvas', { canvas_id: SHARED })
    expect((read.canvas as { can_edit: boolean }).can_edit).toBe(true)
  })

  it('its own rule still edits on any turn (a workspace canvas, or the owner’s own)', async () => {
    const { tools, run } = setup({ visible: true, ungranted: true, editable: true })
    const read = await run(tools(false, false), 'read_canvas', { canvas_id: SHARED })
    expect((read.canvas as { can_edit: boolean }).can_edit).toBe(true)
  })

  it('a guest’s or a linked agent’s turn opens nothing a grant opens (519), and never asks the granted rule', async () => {
    const { tools, run, rpc } = setup({ visible: true, ungranted: false, editable: true })
    const read = await run(tools(false, true), 'read_canvas', { canvas_id: SHARED })
    expect(read.success).toBe(false)
    expect(String(read.error)).toContain('No canvas with that id')
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain('canvas_visible_to')
  })
})
