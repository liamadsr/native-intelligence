/**
 * The editor keeps a Mac-job step (L5, run_local_agent) as it is: it loads and
 * saves as itself, never as an unfinished webhook, with its folder, request
 * and mode untouched (the step is set up in chat; the editor has no controls
 * for it).
 */
import { describe, expect, it } from 'vitest'
import { buildSavePayload, flowToEditor, isActionComplete, type Flow } from '../flow-types'

const FOLDER = '66666666-6666-4666-8666-666666666666'

const flow = {
  id: 'flow-1', workspace_id: 'ws', team_id: null, name: 'CI watch', description: null, enabled: true,
  trigger_type: 'schedule', trigger_config: { kind: 'schedule', cadence: 'daily', time: '09:00', timezone: 'UTC' },
  actions: [
    { id: 'mac', type: 'run_local_agent', config: { folder_id: FOLDER, request: 'Look at {{entity.name}}', mode: 'edit' }, condition: null, parent_id: null, enabled: true, bearer_token_present: false },
    { id: 'draft', type: 'run_local_agent', config: { folder_id: '', request: '' }, condition: null, parent_id: null, enabled: false, bearer_token_present: false },
  ],
  canvas_layout: {}, created_by: 'u', created_at: '', updated_at: '', seed_key: null, ai_team_member_id: 'bot-1',
  bot: { id: 'bot-1', name: 'Scout', bot_character: null, fronts_only: true, is_system: false, system_key: null },
} as unknown as Flow

describe('the editor and a Mac-job step', () => {
  it('survives a load and a save as itself', () => {
    const editor = flowToEditor(flow)
    const mac = editor.actions.find((a) => a.id === 'mac')!
    expect(mac).toMatchObject({ type: 'run_local_agent', stored_local_agent: { folder_id: FOLDER, request: 'Look at {{entity.name}}', mode: 'edit' } })
    expect(isActionComplete(mac)).toBe(true)
    expect(isActionComplete(editor.actions.find((a) => a.id === 'draft')!)).toBe(false)
    const saved = buildSavePayload(editor)
    if (!('payload' in saved)) throw new Error(saved.error)
    const actions = saved.payload.actions as Array<{ id: string; type: string; config: Record<string, unknown> }>
    expect(actions.find((a) => a.id === 'mac')).toMatchObject({ type: 'run_local_agent', config: { folder_id: FOLDER, request: 'Look at {{entity.name}}', mode: 'edit' } })
    expect(actions.find((a) => a.id === 'draft')).toMatchObject({ type: 'run_local_agent', config: { folder_id: '', request: '' } })
  })
})
