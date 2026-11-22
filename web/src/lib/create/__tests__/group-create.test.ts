import { describe, it, expect } from 'vitest'
import { actionPresetForGroup, groupCreateRequest } from '../group-create'

const STATE = '11111111-1111-4111-8111-111111111111'
const TEAM = '22222222-2222-4222-8222-222222222222'
const PROJECT = '33333333-3333-4333-8333-333333333333'

describe('a list group’s +', () => {
  it('a status column: its state, from the group’s metadata, and that state’s team', () => {
    const group = { key: 'unstarted::Todo', metadata: { status_id: STATE }, items: [{ id: 'a', team_id: TEAM, workflow_state: { id: STATE } }] }
    expect(actionPresetForGroup('status_id', group)).toEqual({ statusId: STATE, teamId: TEAM })
  })

  it('a status column with no metadata: a row’s state', () => {
    expect(actionPresetForGroup('status_id', { key: 'started::Doing', items: [{ id: 'a', workflow_state: { id: STATE } }] })).toEqual({ statusId: STATE })
    expect(actionPresetForGroup('status_id', { key: 'started::Doing', items: [] })).toEqual({})
  })

  it('a priority, a project, an assignee: the group’s value', () => {
    expect(actionPresetForGroup('priority', { key: 'high', items: [] })).toEqual({ priority: 'high' })
    expect(actionPresetForGroup('project_id', { key: PROJECT, items: [] })).toEqual({ projectId: PROJECT })
    expect(actionPresetForGroup('assignee_id', { key: PROJECT, items: [] })).toEqual({ assigneeId: PROJECT })
  })

  it('no value, an unknown field or a value that isn’t one: nothing preset', () => {
    expect(actionPresetForGroup('project_id', { key: '__none__', items: [] })).toEqual({})
    expect(actionPresetForGroup('labels', { key: 'x', items: [] })).toEqual({})
    expect(actionPresetForGroup('priority', { key: 'whenever', items: [] })).toEqual({})
    expect(actionPresetForGroup(null, { key: 'high', items: [] })).toEqual({})
  })

  it('opens an action with the chips, any other type as itself', () => {
    expect(groupCreateRequest('action', { priority: 'high' })).toEqual({ type: 'action', context: { preset: { priority: 'high' } } })
    expect(groupCreateRequest('action', {})).toEqual({ type: 'action' })
    expect(groupCreateRequest('contact', { priority: 'high' })).toEqual({ type: 'contact' })
  })
})
