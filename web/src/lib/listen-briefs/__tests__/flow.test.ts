import { describe, it, expect } from 'vitest'
import { flowWords, type FlowRow, type RunRow } from '../builders/flow'
import type { Clock } from '../when'

// Sunday Sep 27 2026, 3 PM in Los Angeles.
const clock: Clock = { now: new Date('2026-09-27T22:00:00Z'), timeZone: 'America/Los_Angeles' }

const names = new Map([
  ['skill-digest', 'Weekly digest'],
  ['skill-triage', 'Triage'],
  ['agent-coder', 'Coder'],
  ['st-review', 'In Review'],
  ['st-done', 'Done'],
])

const step = (type: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id: `a-${Math.random()}`,
  type,
  config,
  condition: null,
  parent_id: null,
  enabled: true,
  ...extra,
})

const digest: FlowRow = {
  id: 'flow-1',
  name: 'Weekly digest',
  description: 'Sums up the week for the team.',
  enabled: true,
  trigger_type: 'schedule',
  trigger_config: { cadence: 'weekly', weekday: 5, time: '16:00', timezone: 'America/Los_Angeles' },
  actions: [step('run_skill', { skill_id: 'skill-digest', mode: 'report' })],
  next_run_at: '2026-10-02T23:00:00Z', // Fri Oct 2, 4 PM PDT
}

const worked: RunRow = { status: 'success', fired_at: '2026-09-25T23:00:00Z' } // Fri Sep 25, 4 PM PDT

const words = (flow: FlowRow, lastRun: RunRow | null = null) => flowWords({ flow, names, lastRun }, { clock }).toArray()

describe('flowWords', () => {
  it('what it is and is for, when it runs, what it does, when next, and how its last run went', () => {
    expect(words(digest, worked)).toEqual([
      'Weekly digest, a flow.',
      'Sums up the week for the team.',
      'It runs every Friday at 4 PM.',
      'It runs the Weekly digest skill, saves the result as a document and notifies you.',
      'It runs next on Friday at 4 PM.',
      'It last ran on Friday, and it worked.',
    ])
  })

  it('steps one after another, one that can make changes, one only when its conditions match, and ones turned off', () => {
    const cleanup: FlowRow = {
      ...digest,
      name: 'Meeting cleanup',
      description: null,
      trigger_type: 'capture_processed',
      trigger_config: {},
      next_run_at: null,
      actions: [
        step(
          'run_skill',
          { skill_id: 'skill-triage', mode: 'act', deliver: { document: false } },
          { condition: { match: 'all', rules: [{ field: 'label', op: 'in', value: ['l1'] }] } },
        ),
        step('archive_capture'),
        step('http_post', { url: 'https://www.hooks.acme.com/dial8?x=1' }, { enabled: false }),
        step('run_agent', { agent_id: 'agent-coder', repo: 'acme/web' }),
      ],
    }
    expect(words(cleanup)).toEqual([
      'Meeting cleanup, a flow.',
      'It runs after every meeting, once its notes are ready.',
      'It runs the Triage skill, which can make changes and notifies you, when its conditions match.',
      'Then it archives the meeting.',
      'Then it hands the work to the Coder agent on acme/web.',
      'One step is turned off.',
      "It hasn't run yet.",
    ])
  })

  it('says each trigger the way people say it', () => {
    const when = (trigger_type: string, trigger_config: FlowRow['trigger_config']) =>
      words({ ...digest, trigger_type, trigger_config })[2]
    expect(when('schedule', { cadence: 'hourly', timezone: 'America/Los_Angeles' })).toBe('It runs every hour.')
    expect(when('schedule', { cadence: 'daily', time: '12:00', timezone: 'America/Los_Angeles' })).toBe('It runs every day at noon.')
    expect(when('schedule', { cadence: 'weekdays', time: '09:30', timezone: 'America/New_York' })).toBe(
      'It runs every weekday at 9:30 AM, New York time.',
    )
    expect(when('entity_status_change', { entity_type: 'action', from_status_id: 'st-review', to_status_id: 'st-done' })).toBe(
      'It runs when an action moves from In Review to Done.',
    )
    expect(when('entity_status_change', { entity_type: 'project', from_status_id: null, to_status_id: 'completed' })).toBe(
      'It runs when a project moves to completed.',
    )
    expect(when('entity_status_change', { entity_type: 'action', to_status_id: 'st-gone' })).toBe('It runs when an action changes status.')
    expect(when('calendar_event', { event_title: 'Couples Counseling', offset_minutes: -30 })).toBe(
      'It runs 30 minutes before each Couples Counseling.',
    )
    expect(when('calendar_event', { event_title: 'Standup', offset_minutes: 60 })).toBe('It runs an hour after each Standup.')
    expect(when('calendar_event', { event_title: 'Standup', offset_minutes: 0 })).toBe('It runs as each Standup starts.')
  })

  it('a paused flow: says so, and nothing about a next run; a failed or unfinished last run', () => {
    const paused = { ...digest, enabled: false }
    const failed = words(paused, { status: 'failed', fired_at: '2026-09-26T16:00:00Z' })
    expect(failed[0]).toBe('Weekly digest, a paused flow.')
    expect(failed).not.toContain('It runs next on Friday at 4 PM.')
    expect(failed.at(-1)).toBe('Its last run, yesterday at 9 AM, failed.')
    expect(words(digest, { status: 'pending', fired_at: '2026-09-27T21:30:00Z' }).at(-1)).toBe(
      "Its last run started about 30 minutes ago and hasn't finished.",
    )
  })

  it('no steps, all steps off, and more steps than are read', () => {
    expect(words({ ...digest, actions: [] })[3]).toBe("It doesn't have any steps yet.")
    expect(words({ ...digest, actions: [step('archive_capture', {}, { enabled: false })] })[3]).toBe('All its steps are turned off.')
    const many = words({ ...digest, actions: Array.from({ length: 7 }, () => step('archive_capture')) })
    expect(many.slice(3, 10)).toEqual([
      'It archives the meeting.',
      'Then it archives the meeting.',
      'Then it archives the meeting.',
      'Then it archives the meeting.',
      'Then it archives the meeting.',
      'And two more steps.',
      'It runs next on Friday at 4 PM.',
    ])
  })
})
