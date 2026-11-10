import { describe, it, expect } from 'vitest'
import { renderTemplate, buildTemplateContext } from '../template'
import type { RunnerActionData } from '../runner'
import type { TriggerContext } from '../types'

const baseAction: RunnerActionData = {
  kind: 'action',
  id: 'a-1',
  identifier: 'ENG-42',
  title: 'Fix login bug',
  status_id: 's-2',
  status_name: 'In Progress',
  status_category: 'started',
  priority: 2,
  assignees: [{ id: 'm-1', display_name: 'Liam' }],
  assignee_ids: ['m-1'],
  label_ids: ['lbl-bug'],
  labels: [{ id: 'lbl-bug', name: 'bug' }],
  project_id: 'proj-1',
  team_id: 'team-1',
  workspace_id: 'w-1',
}

const baseTrigger: TriggerContext = {
  type: 'entity_status_change',
  entity_type: 'action',
  from_status_id: 's-1',
  to_status_id: 's-2',
  fired_at: '2026-05-26T10:00:00.000Z',
}

const ctx = buildTemplateContext(baseAction, baseTrigger, 'https://nativeintelligence.dev')

describe('renderTemplate', () => {
  it('interpolates simple tokens', () => {
    expect(renderTemplate('Hi {{action.title}}', ctx)).toBe('Hi Fix login bug')
  })

  it('returns empty string for unknown tokens', () => {
    expect(renderTemplate('{{action.does_not_exist}}', ctx)).toBe('')
  })

  it('renders nested object values as JSON', () => {
    const out = renderTemplate('{{action.assignees}}', ctx)
    expect(JSON.parse(out)).toEqual([{ id: 'm-1', display_name: 'Liam' }])
  })

  it('renders the action url token from appBaseUrl', () => {
    expect(renderTemplate('{{action.url}}', ctx)).toBe(
      'https://nativeintelligence.dev/account?action=a-1',
    )
  })

  describe('jsonAware mode', () => {
    it('escapes quotes inside JSON string positions', () => {
      const action = { ...baseAction, title: 'has "quotes" in it' }
      const c = buildTemplateContext(action, baseTrigger, 'https://nativeintelligence.dev')
      const body = renderTemplate('{"text": "{{action.title}}"}', c, {
        jsonAware: true,
      })
      // Resulting body must parse as valid JSON.
      const parsed = JSON.parse(body)
      expect(parsed.text).toBe('has "quotes" in it')
    })

    it('escapes newlines inside JSON string positions', () => {
      const action = { ...baseAction, title: 'line1\nline2' }
      const c = buildTemplateContext(action, baseTrigger, 'https://nativeintelligence.dev')
      const body = renderTemplate('{"text": "{{action.title}}"}', c, {
        jsonAware: true,
      })
      const parsed = JSON.parse(body)
      expect(parsed.text).toBe('line1\nline2')
    })

    it('does NOT escape tokens outside JSON string literals', () => {
      // Token at the top level of a JSON value position — no surrounding quotes.
      const body = renderTemplate('[{{action.priority}}]', ctx, { jsonAware: true })
      expect(body).toBe('[2]')
    })
  })
})

describe('buildTemplateContext — entity-less triggers', () => {
  const captureTrigger: TriggerContext = {
    type: 'capture_processed',
    entity_type: null,
    from_status_id: null,
    to_status_id: null,
    fired_at: '2026-07-01T10:00:00.000Z',
  }
  const scheduleTrigger: TriggerContext = {
    type: 'schedule',
    entity_type: null,
    from_status_id: null,
    to_status_id: null,
    fired_at: '2026-07-01T17:00:00.000Z',
  }

  it('populates the capture namespace for a capture_processed fire', () => {
    const c = buildTemplateContext(null, captureTrigger, 'https://nativeintelligence.dev', {
      capture: { id: 'cap-1', title: 'Weekly standup' },
      workspaceId: 'w-1',
    })
    expect(renderTemplate('{{capture.id}}', c)).toBe('cap-1')
    expect(renderTemplate('{{capture.title}}', c)).toBe('Weekly standup')
    expect(renderTemplate('{{workspace.id}}', c)).toBe('w-1')
    expect(renderTemplate('{{trigger.type}}', c)).toBe('capture_processed')
    // Entity namespaces stay empty, not a crash.
    expect(renderTemplate('{{action.title}}', c)).toBe('')
    expect(renderTemplate('{{entity.name}}', c)).toBe('')
  })

  it('handles a null capture title', () => {
    const c = buildTemplateContext(null, captureTrigger, 'https://nativeintelligence.dev', {
      capture: { id: 'cap-1', title: null },
      workspaceId: 'w-1',
    })
    expect(renderTemplate('{{capture.title}}', c)).toBe('')
    expect(renderTemplate('{{capture.id}}', c)).toBe('cap-1')
  })

  it('builds a schedule context with no entity and no capture', () => {
    const c = buildTemplateContext(null, scheduleTrigger, 'https://nativeintelligence.dev', {
      workspaceId: 'w-1',
    })
    expect(c.capture).toBeNull()
    expect(renderTemplate('{{trigger.type}}', c)).toBe('schedule')
    expect(renderTemplate('{{trigger.fired_at}}', c)).toBe('2026-07-01T17:00:00.000Z')
    expect(renderTemplate('{{trigger.entity_type}}', c)).toBe('')
    expect(renderTemplate('{{capture.title}}', c)).toBe('')
    expect(renderTemplate('{{workspace.id}}', c)).toBe('w-1')
  })

  it('entity-backed fires leave the capture namespace null (tokens render empty)', () => {
    expect(ctx.capture).toBeNull()
    expect(renderTemplate('{{capture.title}}', ctx)).toBe('')
  })
})
