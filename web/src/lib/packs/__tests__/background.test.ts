/**
 * Background runs get the same know-how as the chat (plan Part 3, "Background
 * work"): a skill run whose skill has an area, or a work run whose loop runs
 * one, gains that area's playbook in its prompt, behind the same feature gate.
 * The fake projects the selected columns, so a select that forgot `area` or
 * `system_prompt` fails here.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BACKGROUND_PERSON_STEPS_NOTE } from '../render'
import { AREA_GUIDES } from '../area-guides'
import {
  MAX_TOOL_DERIVED_AREAS,
  areasForSkillRun,
  areasForWorkRun,
  backgroundExpertiseSection,
  workRunExpertiseSection,
} from '../background'

function db() {
  const fake = makeFakeSupabase({ project: true })
  fake.seed('recipe', [
    { id: 'pb-mail', slug: 'mail-playbook', area: 'mail', category: 'skill', is_system: true, workspace_id: null, system_prompt: 'MAIL PLAYBOOK TEXT' },
    { id: 'pb-cal', slug: 'calendar-playbook', area: 'calendar', category: 'skill', is_system: true, workspace_id: null, system_prompt: 'CALENDAR PLAYBOOK TEXT' },
    { id: 'bridge', slug: 'email-bridge', area: 'mail', category: 'skill', is_system: true, workspace_id: null, system_prompt: '# bridge' },
    { id: 'mine', slug: 'our-outbound', area: 'prospecting', category: 'skill', is_system: false, workspace_id: 'ws-1', system_prompt: '# ours' },
    // A workspace skill can't pose as a playbook.
    { id: 'fake-pb', slug: 'crm-playbook', area: 'crm', category: 'skill', is_system: false, workspace_id: 'ws-1', system_prompt: 'NOT A PLAYBOOK' },
  ])
  fake.seed('flow', [
    { id: 'loop-mail', workspace_id: 'ws-1', actions: [{ type: 'run_skill', config: { skill_id: 'bridge' } }] },
    { id: 'loop-none', workspace_id: 'ws-1', actions: [{ type: 'notify', config: {} }] },
  ])
  return fake as unknown as SupabaseClient
}

const full = {}
const noEmail = { edition: 'full', feature_overrides: { email: 'off' } }

describe('which areas a background run works in', () => {
  it('a skill run: its own area first, else the tool groups it enables when they narrow', () => {
    expect(areasForSkillRun({ area: 'mail', enabledTools: ['contacts', 'calendar'] })).toEqual(['mail'])
    expect(areasForSkillRun({ area: null, enabledTools: ['emails', 'search'] })).toEqual(['mail'])
    expect(areasForSkillRun({ area: null, enabledTools: ['emails', 'contacts', 'calendar'] })).toEqual([])
    expect(areasForSkillRun({ area: 'not-an-area', enabledTools: null })).toEqual([])
    expect(MAX_TOOL_DERIVED_AREAS).toBe(2)
  })

  it('a work run: its loop’s skill areas first, else its teammate’s tools when they narrow', () => {
    expect(areasForWorkRun({ loopSkillAreas: ['mail', 'mail'], toolAllowlist: ['get_calendar_events'] })).toEqual(['mail'])
    expect(areasForWorkRun({ loopSkillAreas: [], toolAllowlist: ['get_calendar_events', 'find'] })).toEqual(['calendar'])
    expect(areasForWorkRun({ loopSkillAreas: [], toolAllowlist: null })).toEqual([])
  })

  it('a helper\'s own areas (agent_run.helper_areas) come first, deduplicated; junk is dropped', () => {
    expect(areasForWorkRun({ explicitAreas: ['crm', 'mail'], loopSkillAreas: ['mail', 'calendar'], toolAllowlist: null })).toEqual(['crm', 'mail', 'calendar'])
    expect(areasForWorkRun({ explicitAreas: ['nope', null], loopSkillAreas: [], toolAllowlist: ['get_calendar_events'] })).toEqual(['calendar'])
    // An explicit area wins over a tool-derived guess.
    expect(areasForWorkRun({ explicitAreas: ['crm'], loopSkillAreas: [], toolAllowlist: ['get_calendar_events'] })).toEqual(['crm'])
  })
})

describe('backgroundExpertiseSection', () => {
  it('gives the area’s playbook under its own heading', async () => {
    const section = await backgroundExpertiseSection(db(), { workspaceId: 'ws-1', userId: 'u-1', areas: ['mail'], workspaceSettings: full })
    expect(section).toContain('## Expertise: Mail\n\nMAIL PLAYBOOK TEXT')
    expect(section).not.toContain('CALENDAR')
    expect(section.startsWith('How Dial8 does the areas this run works in')).toBe(true)
  })

  it('says the playbook’s steps that need the person don’t apply here', async () => {
    const section = await backgroundExpertiseSection(db(), { workspaceId: 'ws-1', userId: 'u-1', areas: ['mail'], workspaceSettings: full })
    expect(section).toContain(BACKGROUND_PERSON_STEPS_NOTE)
    expect(BACKGROUND_PERSON_STEPS_NOTE).toContain("skip every step that needs the person's yes and report it instead of doing it")
    // Never a licence to write without the yes.
    expect(BACKGROUND_PERSON_STEPS_NOTE).not.toMatch(/don't apply in a background run/)
    expect(BACKGROUND_PERSON_STEPS_NOTE).toContain('`revise_email_draft`')
    // Before the playbook it qualifies.
    expect(section.indexOf(BACKGROUND_PERSON_STEPS_NOTE)).toBeLessThan(section.indexOf('MAIL PLAYBOOK TEXT'))
  })

  it('never loads an area whose feature is off', async () => {
    expect(await backgroundExpertiseSection(db(), { workspaceId: 'ws-1', userId: 'u-1', areas: ['mail'], workspaceSettings: noEmail })).toBe('')
    const both = await backgroundExpertiseSection(db(), { workspaceId: 'ws-1', userId: 'u-1', areas: ['mail', 'calendar'], workspaceSettings: noEmail })
    expect(both).toContain('CALENDAR PLAYBOOK TEXT')
    expect(both).not.toContain('MAIL PLAYBOOK TEXT')
  })

  it('reads only system playbooks: a workspace skill named like one is not one', async () => {
    const section = await backgroundExpertiseSection(db(), { workspaceId: 'ws-1', userId: 'u-1', areas: ['crm'], workspaceSettings: full })
    expect(section).not.toContain('NOT A PLAYBOOK')
    // CRM has no system playbook here: only how its tools work (area-guides.ts).
    expect(section).toContain(`### How CRM works\n${AREA_GUIDES.crm}`)
  })

  it('carries each area\'s guide after its playbook', async () => {
    const section = await backgroundExpertiseSection(db(), { workspaceId: 'ws-1', userId: 'u-1', areas: ['mail'], workspaceSettings: full })
    expect(section.indexOf('MAIL PLAYBOOK TEXT')).toBeGreaterThan(-1)
    expect(section.indexOf('### How Mail works')).toBeGreaterThan(section.indexOf('MAIL PLAYBOOK TEXT'))
    expect(section).toContain(AREA_GUIDES.mail)
  })

  it('is empty with no areas', async () => {
    expect(await backgroundExpertiseSection(db(), { workspaceId: 'ws-1', userId: 'u-1', areas: [] })).toBe('')
  })
})

describe('workRunExpertiseSection', () => {
  it('a run of a loop that runs a Mail skill gets the Mail playbook', async () => {
    const supabase = db()
    // The workspace row the gate reads (no settings passed here).
    ;(supabase as unknown as { seed: (t: string, r: unknown[]) => void }).seed('workspace', [{ id: 'ws-1', settings: {} }])
    const section = await workRunExpertiseSection(supabase, { workspaceId: 'ws-1', userId: 'u-1', flowId: 'loop-mail' })
    expect(section).toContain('MAIL PLAYBOOK TEXT')
  })

  it('a helper with Mail among its areas gets the Mail playbook with no loop or teammate', async () => {
    const supabase = db()
    ;(supabase as unknown as { seed: (t: string, r: unknown[]) => void }).seed('workspace', [{ id: 'ws-1', settings: {} }])
    const section = await workRunExpertiseSection(supabase, { workspaceId: 'ws-1', userId: 'u-1', flowId: null, helperAreas: ['mail'] })
    expect(section).toContain('MAIL PLAYBOOK TEXT')
  })

  it('a run with no loop area and no narrow tools gets nothing', async () => {
    const supabase = db()
    ;(supabase as unknown as { seed: (t: string, r: unknown[]) => void }).seed('workspace', [{ id: 'ws-1', settings: {} }])
    expect(await workRunExpertiseSection(supabase, { workspaceId: 'ws-1', userId: 'u-1', flowId: 'loop-none' })).toBe('')
    expect(await workRunExpertiseSection(supabase, { workspaceId: 'ws-1', userId: 'u-1', flowId: null })).toBe('')
  })
})
