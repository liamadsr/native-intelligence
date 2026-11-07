/**
 * The loop editor's bot in the save payload (bots-v3 Phase 3): a new loop
 * sends the bot it picked (or none, for the server's default); a saved loop
 * sends it only when changed; a saved loop whose bot was deleted asks for one.
 * The payload's keys are what the routes' parseFlowBotInput reads.
 */
import { describe, expect, it } from 'vitest'
import { parseFlowBotInput } from '@/lib/flows/flow-bot'
import { botPayload, buildSavePayload, editorSkillIds, emptyEditor, flowToEditor, newAction, type EditorState, type Flow } from '../flow-types'

function editor(over: Partial<EditorState> = {}): EditorState {
  const e = emptyEditor()
  e.name = 'Weekly brief'
  e.trigger = { ...e.trigger, kind: 'capture_processed' }
  return { ...e, ...over }
}

function payload(e: EditorState): Record<string, unknown> {
  const built = buildSavePayload(e)
  if ('error' in built) throw new Error(built.error)
  return built.payload
}

const savedFlow: Flow = {
  id: 'flow-1',
  workspace_id: 'ws-1',
  team_id: null,
  name: 'Weekly brief',
  description: null,
  enabled: true,
  trigger_type: 'capture_processed',
  trigger_config: {} as Flow['trigger_config'],
  actions: [],
  canvas_layout: {},
  created_by: 'u1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  seed_key: null,
  ai_team_member_id: 'tm-ember',
  bot: { id: 'tm-ember', name: 'Ember', bot_character: 'ember', fronts_only: true, is_system: false, system_key: null },
}

describe('the bot in buildSavePayload', () => {
  it('a new loop sends the teammate it picked, or bot_new and the name typed for a new agent', () => {
    expect(payload(editor({ bot: { kind: 'teammate', id: 'tm-writer' } }))).toMatchObject({ ai_team_member_id: 'tm-writer' })
    // Unnamed: no bot_name, so the server names it after the face it hands it, never the loop.
    const unnamed = payload(editor({ bot: { kind: 'new', name: '' } }))
    expect(unnamed).toMatchObject({ bot_new: true })
    expect(unnamed).not.toHaveProperty('bot_name')
    // No face is sent: a face could match a teammate already wearing it.
    expect(unnamed).not.toHaveProperty('bot_character')
    expect(payload(editor({ bot: { kind: 'new', name: ' Briefer ' } }))).toMatchObject({ bot_new: true, bot_name: 'Briefer' })
  })

  it('a new loop with none picked leaves it to the server’s default', () => {
    const p = payload(editor())
    expect(p).not.toHaveProperty('ai_team_member_id')
    expect(p).not.toHaveProperty('bot_character')
  })

  it('a saved loop sends its bot only when it changed', () => {
    const e = flowToEditor(savedFlow)
    expect(e.bot).toEqual({ kind: 'teammate', id: 'tm-ember' })
    expect(e.botSummary?.name).toBe('Ember')
    expect(payload(e)).not.toHaveProperty('ai_team_member_id')
    expect(payload({ ...e, bot: { kind: 'teammate', id: 'tm-writer' }, botDirty: true })).toMatchObject({ ai_team_member_id: 'tm-writer' })
  })

  it('a saved loop whose bot was deleted asks for one', () => {
    const e = flowToEditor({ ...savedFlow, ai_team_member_id: null, bot: null })
    expect(buildSavePayload(e)).toEqual({ error: 'Pick an agent for this loop: its agent was removed', bot: true })
  })

  it('round-trips through the routes’ reader', () => {
    expect(parseFlowBotInput(botPayload({ kind: 'teammate', id: 'tm-1' }))).toEqual({ kind: 'teammate', teammateId: 'tm-1' })
    expect(parseFlowBotInput(botPayload({ kind: 'new', name: '' }))).toEqual({ kind: 'new', name: null })
    expect(parseFlowBotInput(botPayload({ kind: 'new', name: 'Briefer' }))).toEqual({ kind: 'new', name: 'Briefer' })
  })

  it('suggests from the enabled run_skill actions, each once', () => {
    const a = { ...newAction(), type: 'run_skill' as const, skill_id: 's1' }
    const b = { ...newAction(), type: 'run_skill' as const, skill_id: 's1' }
    const off = { ...newAction(), type: 'run_skill' as const, skill_id: 's2', enabled: false }
    expect(editorSkillIds({ actions: [a, b, off] })).toEqual(['s1'])
  })
})
