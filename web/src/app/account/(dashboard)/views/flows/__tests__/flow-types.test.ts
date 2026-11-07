/**
 * Round-trip tests for the canvas editor's save payload: what buildSavePayload
 * emits must be accepted VERBATIM by the server-side validators in
 * src/lib/flows/queries.ts (the API routes run trigger_config and actions
 * through them on create/update). A field-name drift between the editor and
 * the validators silently breaks saving — these tests pin the contract.
 */
import { describe, expect, it } from 'vitest'
import {
  validateActions,
  validateTriggerConfig,
} from '@/lib/flows/queries'
import type {
  RunAgentActionConfig,
  RunSkillActionConfig,
  ScheduleTriggerConfig,
} from '@/lib/flows/types'
import {
  buildSavePayload,
  emptyEditor,
  flowToEditor,
  isActionComplete,
  isReadOnlyFlow,
  newAction,
  type ArchiveCaptureActionConfig,
  type EditorState,
  type Flow,
} from '../flow-types'

const SKILL_ID = '123e4567-e89b-42d3-a456-426614174000'
const AGENT_ID = '223e4567-e89b-42d3-a456-426614174000'

function baseEditor(): EditorState {
  const editor = emptyEditor()
  editor.name = 'Test flow'
  editor.team_id = 'team-1'
  editor.trigger.to_status_id = 'status-1'
  editor.actions[0].url = 'https://example.com/hook'
  return editor
}

function payloadOf(editor: EditorState): Record<string, unknown> {
  const built = buildSavePayload(editor)
  if ('error' in built) throw new Error(`unexpected save error: ${built.error}`)
  return built.payload
}

describe('buildSavePayload → server validators round-trip', () => {
  it('schedule trigger config validates and preserves cadence/time/weekday/timezone', () => {
    const editor = baseEditor()
    editor.trigger = {
      ...editor.trigger,
      kind: 'schedule',
      cadence: 'weekly',
      time: '17:30',
      weekday: 5,
      timezone: 'America/Los_Angeles',
    }
    const payload = payloadOf(editor)
    expect(payload.trigger_type).toBe('schedule')
    const cfg = validateTriggerConfig('schedule', payload.trigger_config)
    expect(cfg).not.toBeInstanceOf(Error)
    expect(cfg as ScheduleTriggerConfig).toEqual({
      kind: 'schedule',
      cadence: 'weekly',
      time: '17:30',
      weekday: 5,
      timezone: 'America/Los_Angeles',
    })
    // Workspace-scoped: no team in the payload.
    expect('team_id' in payload).toBe(false)
  })

  it('hourly schedule omits time (the validator rejects a missing time otherwise)', () => {
    const editor = baseEditor()
    editor.trigger = { ...editor.trigger, kind: 'schedule', cadence: 'hourly', time: '' }
    const payload = payloadOf(editor)
    const cfg = validateTriggerConfig('schedule', payload.trigger_config)
    expect(cfg).not.toBeInstanceOf(Error)
    expect((cfg as ScheduleTriggerConfig).time).toBeUndefined()
  })

  it('non-hourly schedule with no time is rejected client-side', () => {
    const editor = baseEditor()
    editor.trigger = { ...editor.trigger, kind: 'schedule', cadence: 'daily', time: '' }
    const built = buildSavePayload(editor)
    expect(built).toHaveProperty('error', 'Schedule time is required')
  })

  it('capture_processed trigger validates and omits team_id', () => {
    const editor = baseEditor()
    editor.team_id = '' // teamless workspace can still save this
    editor.trigger = { ...editor.trigger, kind: 'capture_processed' }
    const payload = payloadOf(editor)
    expect(payload.trigger_type).toBe('capture_processed')
    expect('team_id' in payload).toBe(false)
    const cfg = validateTriggerConfig('capture_processed', payload.trigger_config)
    expect(cfg).toEqual({ kind: 'capture_processed' })
  })

  it('entity_status_change still requires a team and target status', () => {
    const editor = baseEditor()
    editor.team_id = ''
    expect(buildSavePayload(editor)).toHaveProperty('error', 'Team is required')
    editor.team_id = 'team-1'
    editor.trigger.to_status_id = ''
    expect(buildSavePayload(editor)).toHaveProperty('error', 'Target status is required')
  })

  it('run_skill action validates and preserves skill_id/mode/instructions/deliver', () => {
    const editor = baseEditor()
    editor.actions[0] = {
      ...newAction(),
      type: 'run_skill',
      skill_id: SKILL_ID,
      mode: 'act',
      instructions: 'Focus on open proposals',
      deliver_document: true,
      deliver_notification: false,
    }
    const payload = payloadOf(editor)
    const validated = validateActions(payload.actions)
    expect(validated).not.toBeInstanceOf(Error)
    const [action] = validated as Exclude<typeof validated, Error>
    expect(action.type).toBe('run_skill')
    expect(action.config as RunSkillActionConfig).toEqual({
      skill_id: SKILL_ID,
      mode: 'act',
      instructions: 'Focus on open proposals',
      deliver: { document: true, notification: false },
    })
  })

  it('run_skill defaults: report mode, both deliveries on, no instructions key, no model key', () => {
    const editor = baseEditor()
    editor.actions[0] = { ...newAction(), type: 'run_skill', skill_id: SKILL_ID }
    const payload = payloadOf(editor)
    const validated = validateActions(payload.actions)
    expect(validated).not.toBeInstanceOf(Error)
    const [action] = validated as Exclude<typeof validated, Error>
    expect(action.config as RunSkillActionConfig).toEqual({
      skill_id: SKILL_ID,
      mode: 'report',
      deliver: { document: true, notification: true },
    })
  })

  it('run_skill never serializes a model: the server picks one per run', () => {
    const editor = baseEditor()
    editor.actions[0] = { ...newAction(), type: 'run_skill', skill_id: SKILL_ID }
    const payload = payloadOf(editor)
    const actions = payload.actions as Array<{ config: Record<string, unknown> }>
    expect('model' in actions[0].config).toBe(false)
    expect('model' in newAction()).toBe(false)
  })

  it('a model an old client still sends is dropped by validation, never an error', () => {
    const validated = validateActions([
      {
        type: 'run_skill',
        config: { skill_id: SKILL_ID, mode: 'report', model: 'claude-sonnet-4-5-20250929' },
      },
      {
        type: 'run_skill',
        config: { skill_id: SKILL_ID, mode: 'report', model: 'not-a-model' },
      },
    ])
    expect(validated).not.toBeInstanceOf(Error)
    for (const action of validated as Exclude<typeof validated, Error>) {
      expect('model' in (action.config as unknown as Record<string, unknown>)).toBe(false)
    }
  })

  it('a run_skill draft (no skill picked) still saves — skipped at fire time', () => {
    const editor = baseEditor()
    editor.actions[0] = { ...newAction(), type: 'run_skill', skill_id: '' }
    const payload = payloadOf(editor)
    const validated = validateActions(payload.actions)
    expect(validated).not.toBeInstanceOf(Error)
    expect(isActionComplete(editor.actions[0])).toBe(false)
  })

  it('archive_capture action round-trips (empty config, always complete)', () => {
    const editor = baseEditor()
    // Use a capture_processed trigger so the action is in its natural home.
    editor.team_id = ''
    editor.trigger = { ...editor.trigger, kind: 'capture_processed' }
    editor.actions[0] = { ...newAction(), type: 'archive_capture' }
    const payload = payloadOf(editor)
    const validated = validateActions(payload.actions)
    expect(validated).not.toBeInstanceOf(Error)
    const [action] = validated as Exclude<typeof validated, Error>
    expect(action.type).toBe('archive_capture')
    expect(action.config).toEqual({})
    // No config to fill in → always complete (never a draft).
    expect(isActionComplete(editor.actions[0])).toBe(true)
  })

  it('run_agent action validates and preserves agent_id/repo/instructions', () => {
    const editor = baseEditor()
    editor.actions[0] = {
      ...newAction(),
      type: 'run_agent',
      agent_id: AGENT_ID,
      repo: 'acme/widgets',
      agent_instructions: 'Fix {{capture.title}}',
    }
    const payload = payloadOf(editor)
    const validated = validateActions(payload.actions)
    expect(validated).not.toBeInstanceOf(Error)
    const [action] = validated as Exclude<typeof validated, Error>
    expect(action.type).toBe('run_agent')
    expect(action.config as RunAgentActionConfig).toEqual({
      agent_id: AGENT_ID,
      repo: 'acme/widgets',
      instructions: 'Fix {{capture.title}}',
    })
  })

  it('run_agent with use_triggering_action_context serializes the override + empty fields', () => {
    const editor = baseEditor()
    editor.actions[0] = {
      ...newAction(),
      type: 'run_agent',
      agent_id: '',
      repo: '',
      agent_instructions: '',
      use_triggering_action_context: true,
    }
    const payload = payloadOf(editor)
    const validated = validateActions(payload.actions)
    expect(validated).not.toBeInstanceOf(Error)
    const [action] = validated as Exclude<typeof validated, Error>
    expect(action.config as RunAgentActionConfig).toEqual({
      agent_id: '',
      repo: '',
      instructions: '',
      use_triggering_action_context: true,
    })
    // Inheriting from the action makes it "complete" for the canvas draft check.
    expect(isActionComplete(editor.actions[0])).toBe(true)
  })

  it('a run_agent draft (no agent/repo) still saves — skipped at fire time', () => {
    const editor = baseEditor()
    editor.actions[0] = { ...newAction(), type: 'run_agent', agent_id: '', repo: '' }
    const payload = payloadOf(editor)
    const validated = validateActions(payload.actions)
    expect(validated).not.toBeInstanceOf(Error)
    expect(isActionComplete(editor.actions[0])).toBe(false)
  })
})

describe('flowToEditor (API → editor)', () => {
  function apiFlow(overrides: Partial<Flow>): Flow {
    return {
      id: 'flow-1',
      workspace_id: 'ws-1',
      team_id: null,
      name: 'Loop',
      description: null,
      enabled: true,
      trigger_type: 'schedule',
      trigger_config: { kind: 'schedule', cadence: 'weekdays', time: '09:15', timezone: 'Europe/Paris' },
      actions: [],
      canvas_layout: {},
      created_by: 'user-1',
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:00:00Z',
      ...overrides,
    }
  }

  it('maps a schedule flow onto the editor trigger', () => {
    const editor = flowToEditor(apiFlow({}))
    expect(editor.trigger.kind).toBe('schedule')
    expect(editor.trigger.cadence).toBe('weekdays')
    expect(editor.trigger.time).toBe('09:15')
    expect(editor.trigger.timezone).toBe('Europe/Paris')
  })

  it('maps a capture_processed flow and a run_skill action', () => {
    const editor = flowToEditor(
      apiFlow({
        trigger_type: 'capture_processed',
        trigger_config: { kind: 'capture_processed' },
        actions: [
          {
            id: 'a1',
            type: 'run_skill',
            config: {
              skill_id: SKILL_ID,
              mode: 'act',
              instructions: 'triage',
              deliver: { document: false, notification: true },
            },
            condition: null,
            parent_id: null,
            enabled: true,
            bearer_token_present: false,
          },
        ],
      }),
    )
    expect(editor.trigger.kind).toBe('capture_processed')
    const a = editor.actions[0]
    expect(a.type).toBe('run_skill')
    expect(a.skill_id).toBe(SKILL_ID)
    expect(a.mode).toBe('act')
    expect(a.instructions).toBe('triage')
    expect(a.deliver_document).toBe(false)
    expect(a.deliver_notification).toBe(true)
  })

  it('drops a stored run_skill model (the old per-loop pin): a re-save never carries it', () => {
    const withModel = flowToEditor(
      apiFlow({
        trigger_type: 'capture_processed',
        trigger_config: { kind: 'capture_processed' },
        actions: [
          {
            id: 'a1',
            type: 'run_skill',
            config: { skill_id: SKILL_ID, mode: 'report', model: 'kimi-k3' } as RunSkillActionConfig,
            condition: null,
            parent_id: null,
            enabled: true,
            bearer_token_present: false,
          },
        ],
      }),
    )
    expect('model' in withModel.actions[0]).toBe(false)
    const editor = baseEditor()
    editor.actions[0] = withModel.actions[0]
    const actions = payloadOf(editor).actions as Array<{ config: Record<string, unknown> }>
    expect('model' in actions[0].config).toBe(false)
  })

  it('maps a run_agent action back onto the editor', () => {
    const editor = flowToEditor(
      apiFlow({
        trigger_type: 'capture_processed',
        trigger_config: { kind: 'capture_processed' },
        actions: [
          {
            id: 'a1',
            type: 'run_agent',
            config: {
              agent_id: AGENT_ID,
              repo: 'acme/widgets',
              instructions: 'ship it',
              use_triggering_action_context: false,
            },
            condition: null,
            parent_id: null,
            enabled: true,
            bearer_token_present: false,
          },
        ],
      }),
    )
    const a = editor.actions[0]
    expect(a.type).toBe('run_agent')
    expect(a.agent_id).toBe(AGENT_ID)
    expect(a.repo).toBe('acme/widgets')
    expect(a.agent_instructions).toBe('ship it')
    expect(a.use_triggering_action_context).toBe(false)
  })

  it('maps a stored archive_capture action back onto the editor', () => {
    const editor = flowToEditor(
      apiFlow({
        trigger_type: 'capture_processed',
        trigger_config: { kind: 'capture_processed' },
        actions: [
          {
            id: 'a1',
            type: 'archive_capture',
            config: {} as ArchiveCaptureActionConfig,
            condition: null,
            parent_id: null,
            enabled: true,
            bearer_token_present: false,
          },
        ],
      }),
    )
    expect(editor.actions[0].type).toBe('archive_capture')
  })

  it('treats a legacy config without kind as entity_status_change', () => {
    const editor = flowToEditor(
      apiFlow({
        trigger_type: 'entity_status_change',
        team_id: 'team-1',
        trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 's-1' },
      }),
    )
    expect(editor.trigger.kind).toBe('entity_status_change')
    expect(editor.trigger.from_status_id).toBe('__any__')
    expect(editor.trigger.to_status_id).toBe('s-1')
  })
})

describe("someone else's loop in the editor (F1: the owner is fixed)", () => {
  const theirs = (over: Partial<Flow> = {}) =>
    ({
      id: 'flow-1',
      workspace_id: 'ws-1',
      team_id: null,
      name: 'Nightly',
      description: null,
      enabled: true,
      trigger_type: 'schedule',
      trigger_config: { kind: 'schedule', cadence: 'daily', time: '09:00', timezone: 'UTC' },
      actions: [],
      canvas_layout: {},
      created_by: 'user-1',
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:00:00Z',
      ai_team_member_id: 'tm-ember',
      bot: { id: 'tm-ember', name: 'Ember', bot_character: 'ember', fronts_only: true, is_system: false, system_key: null },
      owner: { user_id: 'user-1', name: 'Liam' },
      viewer_is_owner: false,
      takeover_pending: true,
      ...over,
    }) as unknown as Flow

  it('reads as owned by them (read-only), with the pending request; the owner and a new loop are not', () => {
    expect(flowToEditor(theirs()).ownedBy).toEqual({ name: 'Liam', requested: true })
    expect(isReadOnlyFlow(flowToEditor(theirs()))).toBe(true)
    expect(flowToEditor(theirs({ viewer_is_owner: true })).ownedBy).toBeNull()
    expect(emptyEditor().ownedBy).toBeNull()
  })

  it('its save carries only what a non-owner may change: never the trigger or the steps', () => {
    const editor = flowToEditor(theirs())
    editor.name = 'Renamed'
    editor.enabled = false
    expect(payloadOf(editor)).toEqual({ name: 'Renamed', description: null, enabled: false, canvas_layout: expect.any(Object) })
  })
})

describe('a chat-made PR loop round-trips through the canvas (F1 review)', () => {
  it('loads as a Pull request trigger and saves the same config, which the server accepts', () => {
    const flow = {
      id: 'flow-1',
      workspace_id: 'ws-1',
      team_id: null,
      name: 'Merged',
      description: null,
      enabled: false,
      trigger_type: 'pr_status_changed',
      trigger_config: { kind: 'pr_status_changed', repo_full_name: 'acme/web', to_state: 'merged' },
      actions: [],
      canvas_layout: {},
      created_by: 'user-1',
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:00:00Z',
      ai_team_member_id: 'tm-ember',
      bot: { id: 'tm-ember', name: 'Ember', bot_character: 'ember', fronts_only: true, is_system: false, system_key: null },
    } as unknown as Flow
    const editor = flowToEditor(flow)
    expect(editor.trigger).toMatchObject({ kind: 'pr_status_changed', repo_full_name: 'acme/web', pr_state: 'merged' })
    editor.actions[0].url = 'https://example.com/hook'
    const payload = payloadOf(editor)
    expect(payload).toMatchObject({ trigger_type: 'pr_status_changed', trigger_config: { kind: 'pr_status_changed', repo_full_name: 'acme/web', to_state: 'merged' } })
    expect(payload).not.toHaveProperty('team_id')
    expect(validateTriggerConfig('pr_status_changed', payload.trigger_config)).not.toBeInstanceOf(Error)
  })

  it('a PR trigger with no repository is a save error', () => {
    const editor = baseEditor()
    editor.trigger = { ...editor.trigger, kind: 'pr_status_changed', repo_full_name: '' }
    expect(buildSavePayload(editor)).toMatchObject({ error: 'Repository is required, as owner/repo' })
  })
})

describe('a UI save keeps what the editor cannot show (F1: the trust drop)', () => {
  const TRUST = { auto_apply: true, min_confidence: 0.9, allow_external: false as const, max_cards_per_run: 3, outreach_draft_cards: false }
  function storedFlow(config: Record<string, unknown>): Flow {
    return {
      id: 'flow-1',
      workspace_id: 'ws-1',
      team_id: null,
      name: 'Triage',
      description: null,
      enabled: true,
      trigger_type: 'capture_processed',
      trigger_config: { kind: 'capture_processed' },
      actions: [
        {
          id: 'a1',
          type: 'run_skill',
          config: { skill_id: SKILL_ID, mode: 'act', deliver: { document: true, notification: false, document_title: 'Triage — {date}' }, trust: TRUST, ...config } as RunSkillActionConfig,
          condition: null,
          parent_id: null,
          enabled: true,
          bearer_token_present: false,
        },
      ],
      canvas_layout: {},
      created_by: 'user-1',
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:00:00Z',
      ai_team_member_id: 'tm-ember',
      bot: { id: 'tm-ember', name: 'Ember', bot_character: 'ember', fronts_only: true, is_system: false, system_key: null },
    } as Flow
  }
  const savedConfig = (editor: EditorState) => {
    const actions = payloadOf(editor).actions as Array<{ config: Record<string, unknown> }>
    return actions[0].config
  }

  it('load → save round-trips the stored trust and report title, and the validator keeps them', () => {
    const editor = flowToEditor(storedFlow({}))
    const config = savedConfig(editor)
    expect(config.trust).toEqual(TRUST)
    expect(config.deliver).toEqual({ document: true, notification: false, document_title: 'Triage — {date}' })
    const validated = validateActions(payloadOf(editor).actions)
    if (validated instanceof Error) throw validated
    const vc = validated[0].config as RunSkillActionConfig
    expect(vc.trust).toMatchObject({ auto_apply: true, min_confidence: 0.9 })
    expect(vc.deliver?.document_title).toBe('Triage — {date}')
  })

  it('an edit the person makes still saves, with the kept fields beside it', () => {
    const editor = flowToEditor(storedFlow({}))
    editor.actions[0].instructions = 'only mine'
    editor.actions[0].deliver_notification = true
    const config = savedConfig(editor)
    expect(config).toMatchObject({ instructions: 'only mine', trust: TRUST, deliver: { notification: true, document_title: 'Triage — {date}' } })
  })

  it('picking another skill drops them (they were set for the old one)', () => {
    const editor = flowToEditor(storedFlow({}))
    editor.actions[0].skill_id = '323e4567-e89b-42d3-a456-426614174000'
    const config = savedConfig(editor)
    expect(config.trust).toBeUndefined()
    expect(config.deliver).toEqual({ document: true, notification: false })
  })

  it('moved from report into act, a carried trust never auto-applies', () => {
    const editor = flowToEditor(storedFlow({ mode: 'report' }))
    editor.actions[0].mode = 'act'
    expect(savedConfig(editor).trust).toEqual({ ...TRUST, auto_apply: false })
  })

  it('a new run_skill action carries nothing extra', () => {
    const editor = baseEditor()
    editor.actions[0] = { ...newAction(), type: 'run_skill', skill_id: SKILL_ID }
    const config = savedConfig(editor)
    expect(config).not.toHaveProperty('trust')
    expect(config.deliver).toEqual({ document: true, notification: true })
  })
})
