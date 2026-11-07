import { describe, it, expect } from 'vitest'
import {
  findTriggerActionMismatch,
  validateHttpPostConfig,
  validateStatusChangeConfig,
  validateScheduleConfig,
  validateCaptureProcessedConfig,
  validateCalendarEventConfig,
  validateTriggerConfig,
  validateRunSkillConfig,
  validateRunAgentConfig,
  validateActions,
  validateCondition,
  validateCanvasLayout,
  toPublicFlow,
  MAX_ENABLED_RUN_SKILL_ACTIONS,
  MAX_ENABLED_RUN_AGENT_ACTIONS,
} from '../queries'
import type { HttpPostActionConfig, RunSkillActionConfig } from '../types'

describe('validateStatusChangeConfig', () => {
  it('accepts a valid config with from_status_id null', () => {
    const out = validateStatusChangeConfig({
      entity_type: 'action',
      from_status_id: null,
      to_status_id: 'abc',
    })
    expect(out).not.toBeInstanceOf(Error)
    expect(out).toEqual({
      entity_type: 'action',
      from_status_id: null,
      to_status_id: 'abc',
    })
  })

  it('accepts a config with explicit from_status_id', () => {
    const out = validateStatusChangeConfig({
      entity_type: 'action',
      from_status_id: 'x',
      to_status_id: 'y',
    })
    expect(out).toEqual({
      entity_type: 'action',
      from_status_id: 'x',
      to_status_id: 'y',
    })
  })

  it('keeps the loop-guard opt-in only when explicitly true', () => {
    const on = validateStatusChangeConfig({ entity_type: 'action', from_status_id: null, to_status_id: 'abc', fire_on_agent_changes: true })
    expect(on).toMatchObject({ fire_on_agent_changes: true })
    const off = validateStatusChangeConfig({ entity_type: 'action', from_status_id: null, to_status_id: 'abc', fire_on_agent_changes: 'yes' })
    expect(off).not.toBeInstanceOf(Error)
    expect(off).not.toHaveProperty('fire_on_agent_changes')
  })

  it('defaults entity_type to "action" when omitted', () => {
    const out = validateStatusChangeConfig({
      from_status_id: null,
      to_status_id: 'abc',
    })
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect(out.entity_type).toBe('action')
  })

  it('accepts project/initiative/milestone with valid enum values', () => {
    const cases: Array<[string, string]> = [
      ['project', 'active'],
      ['project', 'canceled'],
      ['initiative', 'planned'],
      ['initiative', 'archived'],
      ['milestone', 'pending'],
      ['milestone', 'in_progress'],
    ]
    for (const [entity_type, to_status_id] of cases) {
      const out = validateStatusChangeConfig({
        entity_type,
        from_status_id: null,
        to_status_id,
      })
      expect(out, `${entity_type}/${to_status_id} should be accepted`).not.toBeInstanceOf(Error)
    }
  })

  it('rejects invalid enum values for non-action entity types', () => {
    const cases: Array<[string, string]> = [
      ['project', 'not_a_status'],
      ['initiative', 'paused'], // valid for project, not for initiative
      ['milestone', 'archived'], // valid for initiative, not for milestone
    ]
    for (const [entity_type, to_status_id] of cases) {
      const out = validateStatusChangeConfig({
        entity_type,
        from_status_id: null,
        to_status_id,
      })
      expect(out, `${entity_type}/${to_status_id} should be rejected`).toBeInstanceOf(Error)
    }
  })

  it('rejects unknown entity_type', () => {
    const out = validateStatusChangeConfig({
      entity_type: 'random',
      from_status_id: null,
      to_status_id: 'abc',
    })
    expect(out).toBeInstanceOf(Error)
  })

  it('rejects invalid from_status_id enum value for non-action types', () => {
    const out = validateStatusChangeConfig({
      entity_type: 'project',
      from_status_id: 'bogus',
      to_status_id: 'active',
    })
    expect(out).toBeInstanceOf(Error)
  })

  it('accepts arbitrary string for action to_status_id (UUID not enforced here)', () => {
    // Action statuses are workflow_state UUIDs; we don't enforce UUID format
    // at this layer — the DB FK does. Any non-empty string passes.
    const out = validateStatusChangeConfig({
      entity_type: 'action',
      from_status_id: null,
      to_status_id: 'not-a-uuid-but-non-empty',
    })
    expect(out).not.toBeInstanceOf(Error)
  })

  it('rejects when to_status_id is missing', () => {
    const out = validateStatusChangeConfig({
      entity_type: 'action',
      from_status_id: null,
    })
    expect(out).toBeInstanceOf(Error)
  })

  it('rejects non-object input', () => {
    expect(validateStatusChangeConfig(null)).toBeInstanceOf(Error)
    expect(validateStatusChangeConfig('hi')).toBeInstanceOf(Error)
  })
})

describe('validateScheduleConfig', () => {
  it('accepts a daily config and normalizes to the kind-tagged shape', () => {
    const out = validateScheduleConfig({
      cadence: 'daily',
      time: '09:00',
      timezone: 'America/Los_Angeles',
      extra_key: 'stripped',
    })
    expect(out).toEqual({
      kind: 'schedule',
      cadence: 'daily',
      time: '09:00',
      timezone: 'America/Los_Angeles',
    })
  })

  it('hourly needs no time (and drops one if sent)', () => {
    const out = validateScheduleConfig({ cadence: 'hourly', timezone: 'UTC', time: '09:00' })
    expect(out).toEqual({ kind: 'schedule', cadence: 'hourly', timezone: 'UTC' })
  })

  it('requires time for daily/weekdays/weekly', () => {
    for (const cadence of ['daily', 'weekdays', 'weekly']) {
      const out = validateScheduleConfig({ cadence, timezone: 'UTC', weekday: 1 })
      expect(out, `${cadence} without time should be rejected`).toBeInstanceOf(Error)
    }
  })

  it('rejects malformed time strings', () => {
    for (const time of ['9:00', '24:00', '09:60', '0900', 'nine']) {
      const out = validateScheduleConfig({ cadence: 'daily', time, timezone: 'UTC' })
      expect(out, `time "${time}" should be rejected`).toBeInstanceOf(Error)
    }
  })

  it('weekly accepts weekday 0-6 and requires it', () => {
    const ok = validateScheduleConfig({ cadence: 'weekly', time: '09:00', weekday: 0, timezone: 'UTC' })
    expect(ok).not.toBeInstanceOf(Error)
    if (!(ok instanceof Error)) expect(ok.weekday).toBe(0)
    for (const weekday of [undefined, 7, -1, 1.5, '3']) {
      const out = validateScheduleConfig({ cadence: 'weekly', time: '09:00', weekday, timezone: 'UTC' })
      expect(out, `weekday ${String(weekday)} should be rejected`).toBeInstanceOf(Error)
    }
  })

  it('rejects an unknown cadence', () => {
    expect(validateScheduleConfig({ cadence: 'monthly', time: '09:00', timezone: 'UTC' })).toBeInstanceOf(Error)
  })

  it('rejects a missing or invalid IANA timezone', () => {
    expect(validateScheduleConfig({ cadence: 'daily', time: '09:00' })).toBeInstanceOf(Error)
    expect(
      validateScheduleConfig({ cadence: 'daily', time: '09:00', timezone: 'Mars/Olympus_Mons' }),
    ).toBeInstanceOf(Error)
  })

  it('rejects non-object input', () => {
    expect(validateScheduleConfig(null)).toBeInstanceOf(Error)
    expect(validateScheduleConfig('daily')).toBeInstanceOf(Error)
  })
})

describe('validateCaptureProcessedConfig', () => {
  it('normalizes null/undefined/{} to the bare kind shape', () => {
    for (const raw of [null, undefined, {}, { junk: true }]) {
      expect(validateCaptureProcessedConfig(raw)).toEqual({ kind: 'capture_processed' })
    }
  })
  it('rejects non-object input', () => {
    expect(validateCaptureProcessedConfig('x')).toBeInstanceOf(Error)
    expect(validateCaptureProcessedConfig([1])).toBeInstanceOf(Error)
  })
})

describe('validateCalendarEventConfig', () => {
  it('accepts a title + integer offset and trims the title', () => {
    expect(validateCalendarEventConfig({ event_title: '  Couples Counseling ', offset_minutes: -30 })).toEqual({
      kind: 'calendar_event',
      event_title: 'Couples Counseling',
      offset_minutes: -30,
    })
  })
  it('accepts a zero and a positive (after) offset', () => {
    expect(validateCalendarEventConfig({ event_title: 'Standup', offset_minutes: 0 })).not.toBeInstanceOf(Error)
    expect(validateCalendarEventConfig({ event_title: 'Standup', offset_minutes: 15 })).not.toBeInstanceOf(Error)
  })
  it('requires a non-empty title', () => {
    expect(validateCalendarEventConfig({ event_title: '   ', offset_minutes: 0 })).toBeInstanceOf(Error)
    expect(validateCalendarEventConfig({ offset_minutes: 0 })).toBeInstanceOf(Error)
  })
  it('requires an integer offset', () => {
    expect(validateCalendarEventConfig({ event_title: 'X', offset_minutes: 1.5 })).toBeInstanceOf(Error)
    expect(validateCalendarEventConfig({ event_title: 'X', offset_minutes: '30' })).toBeInstanceOf(Error)
    expect(validateCalendarEventConfig({ event_title: 'X', offset_minutes: NaN })).toBeInstanceOf(Error)
  })
  it('bounds the offset to ±1 day', () => {
    expect(validateCalendarEventConfig({ event_title: 'X', offset_minutes: 1440 })).not.toBeInstanceOf(Error)
    expect(validateCalendarEventConfig({ event_title: 'X', offset_minutes: -1440 })).not.toBeInstanceOf(Error)
    expect(validateCalendarEventConfig({ event_title: 'X', offset_minutes: 1441 })).toBeInstanceOf(Error)
    expect(validateCalendarEventConfig({ event_title: 'X', offset_minutes: -2000 })).toBeInstanceOf(Error)
  })
  it('rejects non-object input', () => {
    expect(validateCalendarEventConfig(null)).toBeInstanceOf(Error)
    expect(validateCalendarEventConfig('x')).toBeInstanceOf(Error)
  })
})

describe('validateTriggerConfig (per-type dispatch)', () => {
  it('routes each wired trigger type to its validator', () => {
    const status = validateTriggerConfig('entity_status_change', {
      entity_type: 'action',
      from_status_id: null,
      to_status_id: 's1',
    })
    expect(status).not.toBeInstanceOf(Error)

    const schedule = validateTriggerConfig('schedule', {
      cadence: 'daily',
      time: '09:00',
      timezone: 'UTC',
    })
    expect(schedule).not.toBeInstanceOf(Error)
    if (!(schedule instanceof Error)) expect(schedule).toHaveProperty('kind', 'schedule')

    const capture = validateTriggerConfig('capture_processed', null)
    expect(capture).toEqual({ kind: 'capture_processed' })

    const calendar = validateTriggerConfig('calendar_event', {
      event_title: 'Couples Counseling',
      offset_minutes: -30,
    })
    expect(calendar).not.toBeInstanceOf(Error)
    if (!(calendar instanceof Error)) expect(calendar).toHaveProperty('kind', 'calendar_event')
  })

  it('rejects unknown trigger types', () => {
    expect(validateTriggerConfig('nope', {})).toBeInstanceOf(Error)
  })

  it('pr_status_changed (F1): needs an owner/repo; to_state defaults to any', () => {
    expect(validateTriggerConfig('pr_status_changed', {})).toBeInstanceOf(Error)
    expect(validateTriggerConfig('pr_status_changed', { repo_full_name: 'not a repo' })).toBeInstanceOf(Error)
    expect(validateTriggerConfig('pr_status_changed', { repo_full_name: 'acme/web', to_state: 'approved' })).toBeInstanceOf(Error)
    expect(validateTriggerConfig('pr_status_changed', { repo_full_name: ' acme/web ' })).toEqual({
      kind: 'pr_status_changed',
      repo_full_name: 'acme/web',
      to_state: 'any',
    })
    expect(validateTriggerConfig('pr_status_changed', { repo_full_name: 'acme/web.site', to_state: 'merged' })).toEqual({
      kind: 'pr_status_changed',
      repo_full_name: 'acme/web.site',
      to_state: 'merged',
    })
  })
})

describe('validateRunSkillConfig', () => {
  const skillId = '11111111-2222-4333-8444-555555555555'

  it('accepts a minimal config and defaults mode to report', () => {
    expect(validateRunSkillConfig({ skill_id: skillId })).toEqual({
      skill_id: skillId,
      mode: 'report',
    })
  })

  it('accepts explicit act mode and the optional fields', () => {
    const out = validateRunSkillConfig({
      skill_id: skillId,
      mode: 'act',
      instructions: 'Look at {{capture.title}}',
      deliver: { document: true, notification: false, document_title: 'Brief — {{trigger.fired_at}}' },
    })
    expect(out).toEqual({
      skill_id: skillId,
      mode: 'act',
      instructions: 'Look at {{capture.title}}',
      deliver: { document: true, notification: false, document_title: 'Brief — {{trigger.fired_at}}' },
    })
  })

  it('silently DROPS any provided model, whatever it is (the server picks the model per run)', () => {
    // An old client or an agent tool call may still send one: never an error,
    // never stored.
    for (const model of ['claude-sonnet-4-5-20250929', 'deepseek-v4-flash', 'gpt-4', '   ', '', 42, null, {}]) {
      const out = validateRunSkillConfig({ skill_id: skillId, model })
      expect(out, String(model)).not.toBeInstanceOf(Error)
      expect(out).not.toHaveProperty('model')
    }
  })

  it('silently DROPS any incoming per-action runtime (loops always run on the server)', () => {
    // The `runtime` key was removed — a stored config never carries it, and an
    // incoming one is neither validated nor persisted (not an error, just dropped).
    const out = validateRunSkillConfig({ skill_id: skillId, runtime: 'local' })
    expect(out).toEqual({ skill_id: skillId, mode: 'report' })
    const out2 = validateRunSkillConfig({ skill_id: skillId, runtime: 'cloud' })
    expect(out2).toEqual({ skill_id: skillId, mode: 'report' })
  })

  it('sanitizes a trust config: clamps confidence + cards, forces allow_external false', () => {
    const out = validateRunSkillConfig({
      skill_id: skillId,
      trust: { auto_apply: true, min_confidence: 1.5, allow_external: true, max_cards_per_run: 999 },
    })
    expect(out).not.toBeInstanceOf(Error)
    expect((out as { trust: unknown }).trust).toEqual({
      auto_apply: true,
      min_confidence: 1, // clamped to [0,1]
      allow_external: false, // FORCED regardless of input
      max_cards_per_run: 20, // clamped to [0,20]
    })
  })

  it('defaults a partial trust config to the safe values', () => {
    const out = validateRunSkillConfig({ skill_id: skillId, trust: {} })
    expect((out as { trust: unknown }).trust).toEqual({
      auto_apply: false,
      min_confidence: 0.85,
      allow_external: false,
      max_cards_per_run: 3,
    })
  })

  it('persists an explicit outreach_draft_cards toggle (WS-2b per-loop switch)', () => {
    const off = validateRunSkillConfig({
      skill_id: skillId,
      trust: {
        auto_apply: true,
        min_confidence: 0.9,
        allow_external: false,
        max_cards_per_run: 3,
        outreach_draft_cards: false,
      },
    })
    expect((off as { trust: { outreach_draft_cards?: unknown } }).trust.outreach_draft_cards).toBe(false)
    // Absent when not set — resolveTrust then defaults it to true at run time, so
    // dropping it here (the pre-fix behavior) made the off-switch un-settable.
    const partial = validateRunSkillConfig({ skill_id: skillId, trust: {} })
    expect((partial as { trust: Record<string, unknown> }).trust).not.toHaveProperty('outreach_draft_cards')
  })

  it('rejects a non-object trust', () => {
    expect(validateRunSkillConfig({ skill_id: skillId, trust: 'yes' })).toBeInstanceOf(Error)
  })

  it('rejects a missing or non-uuid skill_id', () => {
    expect(validateRunSkillConfig({})).toBeInstanceOf(Error)
    expect(validateRunSkillConfig({ skill_id: 'morning-brief' })).toBeInstanceOf(Error)
    expect(validateRunSkillConfig({ skill_id: 42 })).toBeInstanceOf(Error)
  })

  it('rejects an unknown mode', () => {
    expect(validateRunSkillConfig({ skill_id: skillId, mode: 'yolo' })).toBeInstanceOf(Error)
  })

  it('rejects wrong-typed optional fields, drops non-boolean deliver flags', () => {
    expect(validateRunSkillConfig({ skill_id: skillId, instructions: 42 })).toBeInstanceOf(Error)
    expect(validateRunSkillConfig({ skill_id: skillId, deliver: 'yes' })).toBeInstanceOf(Error)
    const out = validateRunSkillConfig({ skill_id: skillId, deliver: { document: 'yes', notification: true } })
    expect(out).not.toBeInstanceOf(Error)
    if (!(out instanceof Error)) expect(out.deliver).toEqual({ notification: true })
  })

  it('rejects non-object input', () => {
    expect(validateRunSkillConfig(null)).toBeInstanceOf(Error)
    expect(validateRunSkillConfig('skill')).toBeInstanceOf(Error)
  })
})

describe('validateRunAgentConfig', () => {
  const agentId = '11111111-2222-4333-8444-555555555555'

  it('accepts a minimal explicit config (agent_id + repo)', () => {
    expect(validateRunAgentConfig({ agent_id: agentId, repo: 'owner/repo' })).toEqual({
      agent_id: agentId,
      repo: 'owner/repo',
      instructions: '',
    })
  })

  it('accepts optional instructions', () => {
    const out = validateRunAgentConfig({
      agent_id: agentId,
      repo: 'acme/widgets',
      instructions: 'Fix {{capture.title}}',
    })
    expect(out).toEqual({ agent_id: agentId, repo: 'acme/widgets', instructions: 'Fix {{capture.title}}' })
  })

  it('allows empty agent_id/repo when use_triggering_action_context is set', () => {
    const out = validateRunAgentConfig({ use_triggering_action_context: true })
    expect(out).toEqual({
      agent_id: '',
      repo: '',
      instructions: '',
      use_triggering_action_context: true,
    })
  })

  it('requires agent_id when not inheriting from the action', () => {
    expect(validateRunAgentConfig({ repo: 'owner/repo' })).toBeInstanceOf(Error)
  })

  it('requires repo when not inheriting from the action', () => {
    expect(validateRunAgentConfig({ agent_id: agentId })).toBeInstanceOf(Error)
  })

  it('rejects a non-uuid agent_id', () => {
    expect(validateRunAgentConfig({ agent_id: 'morning-brief', repo: 'owner/repo' })).toBeInstanceOf(Error)
    expect(validateRunAgentConfig({ agent_id: 42, repo: 'owner/repo' })).toBeInstanceOf(Error)
  })

  it('rejects a malformed repo', () => {
    for (const repo of ['norepo', 'a/b/c', 'owner/', '/repo', 'own er/repo']) {
      expect(validateRunAgentConfig({ agent_id: agentId, repo }), repo).toBeInstanceOf(Error)
    }
  })

  it('rejects wrong-typed optional fields', () => {
    expect(validateRunAgentConfig({ agent_id: agentId, repo: 'owner/repo', instructions: 42 })).toBeInstanceOf(Error)
    expect(
      validateRunAgentConfig({ agent_id: agentId, repo: 'owner/repo', use_triggering_action_context: 'yes' }),
    ).toBeInstanceOf(Error)
  })

  it('rejects non-object input', () => {
    expect(validateRunAgentConfig(null)).toBeInstanceOf(Error)
    expect(validateRunAgentConfig('agent')).toBeInstanceOf(Error)
  })
})

describe('validateHttpPostConfig', () => {
  it('accepts a minimal valid config', () => {
    const out = validateHttpPostConfig({
      method: 'POST',
      url: 'https://example.com/x',
      headers: {},
      body_template: '{}',
    })
    expect(out).toEqual({
      method: 'POST',
      url: 'https://example.com/x',
      headers: {},
      body_template: '{}',
    })
  })

  it('rejects unsupported method', () => {
    const out = validateHttpPostConfig({
      method: 'DELETE',
      url: 'https://example.com',
    })
    expect(out).toBeInstanceOf(Error)
  })

  it('rejects invalid URL', () => {
    const out = validateHttpPostConfig({
      method: 'POST',
      url: 'not a url',
    })
    expect(out).toBeInstanceOf(Error)
  })

  it('rejects localhost / private network targets', () => {
    for (const url of [
      'http://localhost/x',
      'http://127.0.0.1/x',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://169.254.1.1/x',
    ]) {
      const out = validateHttpPostConfig({ method: 'POST', url })
      expect(out, `should reject ${url}`).toBeInstanceOf(Error)
    }
  })

  it('strips an Authorization header from headers map', () => {
    const out = validateHttpPostConfig({
      method: 'POST',
      url: 'https://example.com',
      headers: { Authorization: 'Bearer evil', 'X-Ok': 'fine' },
    })
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect(out.headers).toEqual({ 'X-Ok': 'fine' })
  })

  it('coerces empty/missing body_template to empty string', () => {
    const out = validateHttpPostConfig({
      method: 'POST',
      url: 'https://example.com',
    })
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect(out.body_template).toBe('')
  })
})

function rowWith(actions: unknown[]): Record<string, unknown> {
  return {
    id: 'f1',
    workspace_id: 'w1',
    team_id: 't1',
    name: 'x',
    description: null,
    enabled: true,
    trigger_type: 'entity_status_change',
    trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 's2' },
    actions,
    canvas_layout: {},
    created_by: 'u',
    created_at: 't',
    updated_at: 't',
  }
}

describe('toPublicFlow', () => {
  it('redacts each action token to bearer_token_present and never leaks ciphertext', () => {
    const out = toPublicFlow(
      rowWith([
        {
          id: 'a1',
          type: 'http_post',
          config: { method: 'POST', url: 'https://x', headers: {}, body_template: '' },
          condition: null,
          bearer_token_encrypted: 'v1.aaa.bbb.ccc',
        },
        {
          id: 'a2',
          type: 'http_post',
          config: { method: 'POST', url: 'https://y', headers: {}, body_template: '' },
          condition: null,
          bearer_token_encrypted: null,
        },
      ]),
    )
    expect(out.actions).toHaveLength(2)
    expect(out.actions[0].bearer_token_present).toBe(true)
    expect(out.actions[1].bearer_token_present).toBe(false)
    // Legacy rows (no parent_id/enabled) default to root + enabled.
    expect(out.actions[0].parent_id).toBeNull()
    expect(out.actions[0].enabled).toBe(true)
    expect(JSON.stringify(out)).not.toContain('v1.aaa.bbb.ccc')
    expect(JSON.stringify(out)).not.toContain('bearer_token_encrypted')
  })

  it('drops malformed action entries', () => {
    const out = toPublicFlow(rowWith([null, { type: 'http_post' }, { id: 'ok', type: 'http_post', config: {}, condition: null, bearer_token_encrypted: null }]))
    expect(out.actions).toHaveLength(1)
    expect(out.actions[0].id).toBe('ok')
  })

  it('passes run_skill actions and schedule trigger_config through', () => {
    const skillCfg = { skill_id: '11111111-2222-4333-8444-555555555555', mode: 'report' }
    const row = {
      ...rowWith([{ id: 'a1', type: 'run_skill', config: skillCfg, condition: null }]),
      team_id: null,
      trigger_type: 'schedule',
      trigger_config: { kind: 'schedule', cadence: 'daily', time: '09:00', timezone: 'UTC' },
    }
    const out = toPublicFlow(row)
    expect(out.trigger_type).toBe('schedule')
    expect(out.trigger_config).toEqual({ kind: 'schedule', cadence: 'daily', time: '09:00', timezone: 'UTC' })
    expect(out.team_id).toBeNull()
    expect(out.actions[0].type).toBe('run_skill')
    expect(out.actions[0].config).toEqual(skillCfg)
    expect(out.actions[0].bearer_token_present).toBe(false)
  })

  it('passes archive_capture actions through with their type', () => {
    // It used to fall back to http_post: the editor then showed the step as an
    // unfinished webhook (and saving turned it into one), and the dispatcher,
    // which loads flows through this same mapping, skipped it as incomplete.
    const row = {
      ...rowWith([{ id: 'a1', type: 'archive_capture', config: {}, condition: null, parent_id: null, enabled: true }]),
      team_id: null,
      trigger_type: 'capture_processed',
      trigger_config: { kind: 'capture_processed' },
    }
    const out = toPublicFlow(row)
    expect(out.actions).toHaveLength(1)
    expect(out.actions[0].type).toBe('archive_capture')
    expect(out.actions[0].config).toEqual({})
  })

  it('defaults an unknown stored action type to http_post (legacy rows)', () => {
    const out = toPublicFlow(rowWith([{ id: 'a1', config: {}, condition: null }]))
    expect(out.actions[0].type).toBe('http_post')
  })
})

describe('validateCondition', () => {
  it('null / undefined → null (always run)', () => {
    expect(validateCondition(null)).toBeNull()
    expect(validateCondition(undefined)).toBeNull()
  })
  it('empty rules normalizes to null', () => {
    expect(validateCondition({ match: 'all', rules: [] })).toBeNull()
  })
  it('rejects unknown match / field / op', () => {
    expect(validateCondition({ match: 'maybe', rules: [] })).toBeInstanceOf(Error)
    expect(validateCondition({ match: 'all', rules: [{ field: 'nope', op: 'is', value: 'x' }] })).toBeInstanceOf(Error)
    expect(validateCondition({ match: 'all', rules: [{ field: 'label', op: 'lol', value: 'x' }] })).toBeInstanceOf(Error)
  })
  it('requires value for scalar/array ops, none for nullary', () => {
    expect(validateCondition({ match: 'all', rules: [{ field: 'label', op: 'in', value: 'x' }] })).toBeInstanceOf(Error)
    expect(validateCondition({ match: 'all', rules: [{ field: 'project', op: 'is', value: '' }] })).toBeInstanceOf(Error)
    const ok = validateCondition({ match: 'all', rules: [{ field: 'label', op: 'is_set', value: 'ignored' }] })
    expect(ok).not.toBeInstanceOf(Error)
    if (!(ok instanceof Error) && ok) expect(ok.rules[0].value).toBeNull()
  })
  it('validates priority value range 0-4', () => {
    expect(validateCondition({ match: 'all', rules: [{ field: 'priority', op: 'is', value: '9' }] })).toBeInstanceOf(Error)
    expect(validateCondition({ match: 'all', rules: [{ field: 'priority', op: 'is', value: '2' }] })).not.toBeInstanceOf(Error)
  })
})

describe('validateActions', () => {
  const httpCfg = { method: 'POST', url: 'https://api.example.com/x', headers: {}, body_template: '{}' }
  it('rejects empty/non-array', () => {
    expect(validateActions([])).toBeInstanceOf(Error)
    expect(validateActions('nope')).toBeInstanceOf(Error)
  })
  it('assigns an id when missing and preserves a provided id', () => {
    const out = validateActions([{ type: 'http_post', config: httpCfg, condition: null, id: 'keep-me' }, { type: 'http_post', config: httpCfg }])
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect(out[0].id).toBe('keep-me')
    expect(out[1].id).toMatch(/[0-9a-f-]{36}/)
  })
  it('rejects an unknown action type with the action index', () => {
    const out = validateActions([{ type: 'send_email', config: httpCfg }])
    expect(out).toBeInstanceOf(Error)
    if (out instanceof Error) expect(out.message).toContain('action 1')
  })

  it('does NOT reject a bad/private URL — it saves as a draft (runner guards it)', () => {
    // Previously this rejected; now saving never blocks on a URL. The private
    // host is kept verbatim but the runner's isActionRunnable will skip it.
    const out = validateActions([{ type: 'http_post', config: { ...httpCfg, url: 'http://localhost' } }])
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect((out[0].config as HttpPostActionConfig).url).toBe('http://localhost')
  })

  it('bubbles a malformed CONDITION error with the action index', () => {
    const out = validateActions([
      { type: 'http_post', config: httpCfg, condition: { match: 'all', rules: [{ field: 'nope', op: 'is', value: 'x' }] } },
    ])
    expect(out).toBeInstanceOf(Error)
    if (out instanceof Error) expect(out.message).toContain('action 1')
  })

  it('defaults parent_id null and enabled true', () => {
    const out = validateActions([{ type: 'http_post', config: httpCfg }])
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect(out[0].parent_id).toBeNull()
    expect(out[0].enabled).toBe(true)
  })

  it('drops a run_skill model, valid or not, on both the strict and the draft path', () => {
    const skillId = '11111111-2222-4333-8444-555555555555'
    const out = validateActions([
      { type: 'run_skill', config: { skill_id: skillId, model: 'deepseek-v4-flash' } },
      { type: 'run_skill', config: { skill_id: skillId, model: 'gpt-4' } },
      // A draft (no skill yet) goes through sanitizeDraftRunSkillConfig.
      { type: 'run_skill', enabled: false, config: { skill_id: '', model: 'deepseek-v4-flash' } },
    ])
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    for (const action of out) {
      expect(action.config).not.toHaveProperty('model')
    }
    expect((out[0].config as RunSkillActionConfig).skill_id).toBe(skillId)
  })

  it('resolves a valid parent_id and coerces an unknown parent_id to null (root)', () => {
    const out = validateActions([
      { id: 'p', type: 'http_post', config: httpCfg },
      { id: 'c', type: 'http_post', config: httpCfg, parent_id: 'p' },
      { id: 'orphan', type: 'http_post', config: httpCfg, parent_id: 'nope' },
    ])
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect(out[1].parent_id).toBe('p')
    expect(out[2].parent_id).toBeNull()
  })

  it('rejects a cycle via parent_id', () => {
    const cyc = validateActions([
      { id: 'a', type: 'http_post', config: httpCfg, parent_id: 'b' },
      { id: 'b', type: 'http_post', config: httpCfg, parent_id: 'a' },
    ])
    expect(cyc).toBeInstanceOf(Error)
    if (cyc instanceof Error) expect(cyc.message).toContain('cycle')
  })

  it('rejects duplicate action ids', () => {
    const dup = validateActions([
      { id: 'x', type: 'http_post', config: httpCfg },
      { id: 'x', type: 'http_post', config: httpCfg },
    ])
    expect(dup).toBeInstanceOf(Error)
    if (dup instanceof Error) expect(dup.message).toContain('duplicate')
  })

  it('a self-referential parent_id is coerced to null (not a cycle)', () => {
    const out = validateActions([{ id: 'a', type: 'http_post', config: httpCfg, parent_id: 'a' }])
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect(out[0].parent_id).toBeNull()
  })

  it('saves an incomplete action as a draft instead of rejecting (enabled or not)', () => {
    // Enabled with an empty/half-finished URL → accepted as a draft (skipped at
    // fire time by the runner), NOT rejected. Saving never blocks on a URL.
    const enabledDraft = validateActions([
      { type: 'http_post', enabled: true, config: { method: 'POST', url: '' } },
    ])
    expect(enabledDraft).not.toBeInstanceOf(Error)
    if (enabledDraft instanceof Error) return
    expect(enabledDraft[0].enabled).toBe(true)
    expect((enabledDraft[0].config as HttpPostActionConfig).url).toBe('')

    // Disabled draft also accepted, enabled:false preserved.
    const disabledDraft = validateActions([
      { type: 'http_post', enabled: false, config: { method: 'POST', url: '' } },
    ])
    expect(disabledDraft).not.toBeInstanceOf(Error)
    if (disabledDraft instanceof Error) return
    expect(disabledDraft[0].enabled).toBe(false)
  })

  it('still strips an Authorization header even on a draft (no SSRF/secret leak)', () => {
    // A private-host URL saves as a draft (it won't fire — runner guards it),
    // but the Authorization header is dropped just like the strict path.
    const draft = validateActions([
      {
        type: 'http_post',
        enabled: true,
        config: { method: 'POST', url: 'http://10.0.0.5/x', headers: { Authorization: 'Bearer evil', 'X-Ok': 'y' } },
      },
    ])
    expect(draft).not.toBeInstanceOf(Error)
    if (draft instanceof Error) return
    expect((draft[0].config as HttpPostActionConfig).headers).toEqual({ 'X-Ok': 'y' })
  })

  it('accepts a valid run_skill action and preserves its type + config', () => {
    const skillId = '11111111-2222-4333-8444-555555555555'
    const out = validateActions([
      { type: 'run_skill', config: { skill_id: skillId, mode: 'act', instructions: 'Focus on ENG' } },
    ])
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect(out[0].type).toBe('run_skill')
    expect(out[0].config).toEqual({ skill_id: skillId, mode: 'act', instructions: 'Focus on ENG' })
  })

  it('saves a run_skill with an unresolvable skill_id as a draft (mirrors http_post drafts)', () => {
    const out = validateActions([
      { type: 'run_skill', config: { skill_id: 'not-a-uuid', mode: 'act' } },
    ])
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect(out[0].type).toBe('run_skill')
    expect((out[0].config as RunSkillActionConfig).skill_id).toBe('not-a-uuid')
    expect((out[0].config as RunSkillActionConfig).mode).toBe('act')
  })

  it('accepts a mixed http_post + run_skill tree', () => {
    const skillId = '11111111-2222-4333-8444-555555555555'
    const out = validateActions([
      { id: 'p', type: 'http_post', config: httpCfg },
      { id: 'c', type: 'run_skill', config: { skill_id: skillId }, parent_id: 'p' },
    ])
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect(out[1].type).toBe('run_skill')
    expect(out[1].parent_id).toBe('p')
  })

  it(`caps ENABLED run_skill actions at ${MAX_ENABLED_RUN_SKILL_ACTIONS} (runaway-cost guard)`, () => {
    const skillId = '11111111-2222-4333-8444-555555555555'
    const skill = (enabled: boolean) => ({ type: 'run_skill', enabled, config: { skill_id: skillId } })

    // At the cap: fine.
    const atCap = validateActions(Array.from({ length: MAX_ENABLED_RUN_SKILL_ACTIONS }, () => skill(true)))
    expect(atCap).not.toBeInstanceOf(Error)

    // One over: rejected — each run_skill holds an LLM call up to 240s and the
    // whole flow must fit the 600s maxDuration budget of a single fire.
    const overCap = validateActions(Array.from({ length: MAX_ENABLED_RUN_SKILL_ACTIONS + 1 }, () => skill(true)))
    expect(overCap).toBeInstanceOf(Error)
    if (overCap instanceof Error) expect(overCap.message).toContain('run_skill')

    // Disabled run_skill actions never execute, so they don't count.
    const withDrafts = validateActions([
      ...Array.from({ length: MAX_ENABLED_RUN_SKILL_ACTIONS }, () => skill(true)),
      skill(false),
      skill(false),
    ])
    expect(withDrafts).not.toBeInstanceOf(Error)

    // http_post actions don't count either.
    const withHttp = validateActions([
      ...Array.from({ length: MAX_ENABLED_RUN_SKILL_ACTIONS }, () => skill(true)),
      { type: 'http_post', config: httpCfg },
    ])
    expect(withHttp).not.toBeInstanceOf(Error)

    // EVERY enabled run_skill counts, whatever a caller tries to stuff into
    // config.runtime (which is dropped). One over the cap is still rejected.
    const legacyLocal = { type: 'run_skill', enabled: true, config: { skill_id: skillId, runtime: 'local' } }
    const overWithLegacyRuntime = validateActions(
      Array.from({ length: MAX_ENABLED_RUN_SKILL_ACTIONS + 1 }, () => legacyLocal),
    )
    expect(overWithLegacyRuntime).toBeInstanceOf(Error)
  })

  it('accepts a valid run_agent action and preserves its type + config', () => {
    const agentId = '11111111-2222-4333-8444-555555555555'
    const out = validateActions([
      { type: 'run_agent', config: { agent_id: agentId, repo: 'owner/repo', instructions: 'Fix the bug' } },
    ])
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect(out[0].type).toBe('run_agent')
    expect(out[0].config).toEqual({ agent_id: agentId, repo: 'owner/repo', instructions: 'Fix the bug' })
  })

  it('saves a run_agent with an unresolvable agent_id/repo as a draft', () => {
    const out = validateActions([
      { type: 'run_agent', config: { agent_id: 'not-a-uuid', repo: 'bad' } },
    ])
    expect(out).not.toBeInstanceOf(Error)
    if (out instanceof Error) return
    expect(out[0].type).toBe('run_agent')
    // Sanitized draft shape — kept verbatim, skipped at fire time by the runner.
    expect((out[0].config as { agent_id: string }).agent_id).toBe('not-a-uuid')
  })

  it(`caps ENABLED run_agent actions at ${MAX_ENABLED_RUN_AGENT_ACTIONS} (blast-radius guard)`, () => {
    const agentId = '11111111-2222-4333-8444-555555555555'
    const agent = (enabled: boolean) => ({
      type: 'run_agent',
      enabled,
      config: { agent_id: agentId, repo: 'owner/repo' },
    })

    // At the cap: fine.
    const atCap = validateActions(Array.from({ length: MAX_ENABLED_RUN_AGENT_ACTIONS }, () => agent(true)))
    expect(atCap).not.toBeInstanceOf(Error)

    // One over: rejected.
    const overCap = validateActions(Array.from({ length: MAX_ENABLED_RUN_AGENT_ACTIONS + 1 }, () => agent(true)))
    expect(overCap).toBeInstanceOf(Error)
    if (overCap instanceof Error) expect(overCap.message).toContain('run_agent')

    // Disabled run_agent actions never execute, so they don't count.
    const withDrafts = validateActions([
      ...Array.from({ length: MAX_ENABLED_RUN_AGENT_ACTIONS }, () => agent(true)),
      agent(false),
    ])
    expect(withDrafts).not.toBeInstanceOf(Error)
  })
})

describe('validateCanvasLayout', () => {
  it('keeps finite trigger + per-action coords, drops garbage', () => {
    const out = validateCanvasLayout({
      trigger: { x: 1, y: 2 },
      actions: { a1: { x: 3, y: 4 }, bad: { x: 'nope', y: 5 } },
    })
    expect(out.trigger).toEqual({ x: 1, y: 2 })
    expect(out.actions?.a1).toEqual({ x: 3, y: 4 })
    expect(out.actions?.bad).toBeUndefined()
  })
  it('migrates a legacy single-action key under actions.__legacy__', () => {
    const out = validateCanvasLayout({ trigger: { x: 0, y: 0 }, action: { x: 9, y: 9 } })
    expect(out.actions?.__legacy__).toEqual({ x: 9, y: 9 })
  })
  it('returns {} on garbage', () => {
    expect(validateCanvasLayout('nope')).toEqual({})
    expect(validateCanvasLayout(null)).toEqual({})
  })
})

describe('findTriggerActionMismatch (the shared trigger/action rule)', () => {
  it('an archive_capture needs a capture_processed trigger: the first offender, else null', () => {
    const actions = [{ type: 'http_post' }, { type: 'archive_capture' }, { type: 'archive_capture' }]
    expect(findTriggerActionMismatch('capture_processed', actions)).toBeNull()
    for (const t of ['schedule', 'entity_status_change', 'calendar_event']) {
      expect(findTriggerActionMismatch(t, actions)).toEqual({ index: 1, message: expect.stringContaining('capture_processed trigger') })
    }
    expect(findTriggerActionMismatch('schedule', [{ type: 'http_post' }, { type: 'run_skill' }])).toBeNull()
    expect(findTriggerActionMismatch('schedule', [])).toBeNull()
  })
})

