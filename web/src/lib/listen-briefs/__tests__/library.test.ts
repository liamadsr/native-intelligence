import { describe, it, expect } from 'vitest'
import { libraryWords, type LibraryItemRow } from '../builders/library'

const who = { workspaceId: 'ws-1', userId: 'user-1' }

const PREP_PROMPT = [
  'You prepare the user for ONE specific meeting. Not their day: one meeting, all the way down. You work from what Dial8 already knows. You never invent a fact. You keep it short.',
  '',
  '## Pin the meeting',
  'Find it on the calendar.',
  '',
  '## Who is coming',
  'Each attendee, with what they care about.',
  '',
  '## What happened last time',
  '## What they are waiting on',
  '## The brief',
  '## Rules',
].join('\n')

const skill: LibraryItemRow = {
  id: 'rec-prep',
  name: 'Meeting prep',
  description: 'Prepares you for one specific meeting.',
  category: 'skill',
  slug: 'meeting-prep',
  is_system: true,
  visibility: 'workspace',
  workspace_id: null,
  created_by: null,
  system_prompt: PREP_PROMPT,
  agent_config: { enabled_tools: ['captures', 'actions', 'contacts', 'legacy_scope'] },
}

const agent: LibraryItemRow = {
  id: 'rec-pm',
  name: 'Project Manager',
  description: 'Keeps the board in step with what was said.',
  category: 'agent',
  slug: null,
  is_system: false,
  visibility: 'workspace',
  workspace_id: 'ws-1',
  created_by: 'user-2',
  system_prompt: 'You are the project manager in the room. You listen for commitments and turn them into tracked work.',
  agent_config: null,
}

const words = (item: LibraryItemRow) => libraryWords(item, who).toArray()

describe('libraryWords', () => {
  it('a skill: what it is, how to run it, its tools, what its prompt says first and what it covers', () => {
    expect(words(skill)).toEqual([
      'Meeting prep, a built-in skill.',
      'Prepares you for one specific meeting.',
      'Run it from chat by typing slash meeting prep.',
      'When it runs on its own in a flow, it can use Captures, Actions, Contacts & Companies and legacy scope.',
      'Its prompt says: You prepare the user for ONE specific meeting.',
      'Not their day: one meeting, all the way down.',
      'You work from what Dial8 already knows.',
      'You never invent a fact.',
      'It covers Pin the meeting, Who is coming, What happened last time and three more.',
    ])
  })

  it('an agent: whose it is and how it takes part in meetings', () => {
    expect(words(agent)).toEqual([
      'Project Manager, an agent in your workspace.',
      'Keeps the board in step with what was said.',
      'It sits in on your meetings: it takes the notes, writes the summary and proposes changes.',
      'Its prompt says: You are the project manager in the room.',
      'You listen for commitments and turn them into tracked work.',
    ])
    const helper = words({ ...agent, agent_config: { capture_mode: 'assist_only', enabled_tools: ['captures'] } })
    expect(helper.slice(2, 4)).toEqual([
      'In a live meeting it only helps you, answering and asking, and a pass after the call writes the notes.',
      'It can use Captures.',
    ])
  })

  it('says whose it is: your own, your workspace’s, or from Discover', () => {
    expect(words({ ...agent, visibility: 'personal', created_by: 'user-1' })[0]).toBe('Project Manager, your own agent.')
    expect(words({ ...skill, is_system: false, workspace_id: 'ws-other', visibility: 'public' })[0]).toBe('Meeting prep, a skill from Discover.')
    expect(words({ ...skill, is_system: false, workspace_id: 'ws-1' })[0]).toBe('Meeting prep, a skill in your workspace.')
  })

  it('says only what it has: no description, tools or prompt', () => {
    expect(words({ ...skill, description: null, slug: null, agent_config: null, system_prompt: null })).toEqual([
      'Meeting prep, a built-in skill.',
    ])
    expect(words({ ...skill, name: null, description: null, slug: null, agent_config: null, system_prompt: '## Only headings\n## Here' })).toEqual([
      'This skill, a built-in skill.',
      'It covers Only headings and Here.',
    ])
  })
})
