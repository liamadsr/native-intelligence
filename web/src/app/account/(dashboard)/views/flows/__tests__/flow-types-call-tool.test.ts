/**
 * The editor round-trips F4 steps: a call_tool step loads and saves as itself
 * (never as an unfinished webhook), a skill step's connections set in chat
 * ride a UI save, a bad input is caught before saving, and a step offers only
 * its ancestors' outputs.
 */
import { describe, expect, it } from 'vitest'
import { ancestorSteps, buildSavePayload, flowToEditor, isActionComplete, parseToolInput, type Flow } from '../flow-types'

const CONN = 'aaaaaaaa-0000-4000-8000-000000000002'
const SKILL = 'b0a0af26-be52-493a-a2e4-ea0cb5b6cbbb'

const flow = {
  id: 'flow-1', workspace_id: 'ws', team_id: null, name: 'Objections', description: null, enabled: false,
  trigger_type: 'capture_processed', trigger_config: { kind: 'capture_processed' },
  actions: [
    { id: 'lens', type: 'run_skill', config: { skill_id: SKILL, mode: 'act', connections: [CONN] }, condition: null, parent_id: null, enabled: true, bearer_token_present: false },
    { id: 'log', type: 'call_tool', config: { connection: CONN, tool: 'append', input: { text: '{{steps.lens.output}}' } }, condition: null, parent_id: 'lens', enabled: true, bearer_token_present: false },
    { id: 'other', type: 'archive_capture', config: {}, condition: null, parent_id: null, enabled: true, bearer_token_present: false },
  ],
  canvas_layout: {}, created_by: 'u', created_at: '', updated_at: '', seed_key: null, ai_team_member_id: 'bot-1',
  bot: { id: 'bot-1', name: 'Scout', bot_character: null, fronts_only: true, is_system: false, system_key: null },
} as unknown as Flow

describe('the editor and F4 steps', () => {
  it('a call_tool step and a skill\'s connections survive a load and a save', () => {
    const editor = flowToEditor(flow)
    const log = editor.actions.find((a) => a.id === 'log')!
    expect(log).toMatchObject({ type: 'call_tool', connection: CONN, tool: 'append' })
    expect(isActionComplete(log)).toBe(true)
    const saved = buildSavePayload(editor)
    if (!('payload' in saved)) throw new Error(saved.error)
    const actions = saved.payload.actions as Array<{ id: string; type: string; config: Record<string, unknown> }>
    expect(actions.find((a) => a.id === 'log')).toMatchObject({ type: 'call_tool', config: { connection: CONN, tool: 'append', input: { text: '{{steps.lens.output}}' } } })
    expect(actions.find((a) => a.id === 'lens')!.config.connections).toEqual([CONN])
  })

  it('an input that is not a JSON object is caught before saving', () => {
    const editor = flowToEditor(flow)
    const broken = { ...editor, actions: editor.actions.map((a) => (a.id === 'log' ? { ...a, tool_input: '{"text": ' } : a)) }
    expect(buildSavePayload(broken)).toMatchObject({ error: 'Action 2: the input must be a JSON object', actionIndex: 1 })
    expect(parseToolInput('[]')).toBeNull()
    expect(parseToolInput('')).toEqual({})
  })

  it('a step offers only the outputs of the steps it chains off', () => {
    const editor = flowToEditor(flow)
    expect(ancestorSteps(editor.actions, 'log').map((a) => a.id)).toEqual(['lens'])
    expect(ancestorSteps(editor.actions, 'other')).toEqual([])
  })
})
