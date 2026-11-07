/**
 * Work and notices record their area (one-agent plan, decision 9; migration
 * 318): each writer's kind or its own word stamps `tracked_job.area`, the
 * handle carries it, and the notices a row sends carry it in their metadata,
 * so the face can be picked from the area when they're shown. Against the
 * stateful fake (`project` mode: a select's columns only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import { startWork } from '../recorder'
import { WORK_KINDS } from '../types'
import { KIND_AREAS, areaFaceKey, singleArea, workArea } from '../work-area'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async (_n: Record<string, unknown>) => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))

beforeEach(() => hoisted.createNotification.mockClear())

describe('the area each writer stamps', () => {
  it('capture extraction, triage reconciling and the proposal age-out are Captures’; the email pass and mail import Mail’s', () => {
    expect(workArea(WORK_KINDS.extraction)).toBe('captures')
    expect(workArea(WORK_KINDS.triageReconcile)).toBe('captures')
    expect(workArea(WORK_KINDS.proposalAgeOut)).toBe('captures')
    expect(workArea(WORK_KINDS.emailDrafts)).toBe('mail')
    expect(workArea(WORK_KINDS.emailImport)).toBe('mail')
  })

  it('prospecting, evals, enrichment and the CRM import their own; sequence sends Sequences’', () => {
    expect(workArea(WORK_KINDS.prospecting)).toBe('prospecting')
    expect(workArea(WORK_KINDS.eval)).toBe('evals')
    expect(workArea(WORK_KINDS.crmEnrichment)).toBe('crm')
    expect(workArea(WORK_KINDS.crmImport)).toBe('crm')
    expect(workArea(WORK_KINDS.sequenceEnrolment)).toBe('sequences')
  })

  it('a loop run, a work run and onboarding research take the writer’s area, else none', () => {
    for (const kind of [WORK_KINDS.flowRun, WORK_KINDS.workRun, WORK_KINDS.codingRun, WORK_KINDS.onboardingResearch, WORK_KINDS.skillRun]) {
      expect(workArea(kind)).toBeNull()
    }
    expect(workArea(WORK_KINDS.flowRun, 'calendar')).toBe('calendar')
    // The writer's word wins; a word that isn't an area is no word.
    expect(workArea(WORK_KINDS.extraction, 'mail')).toBe('mail')
    expect(workArea(WORK_KINDS.flowRun, 'inbox')).toBeNull()
  })

  it('every fixed kind is a real area, and the faces are a subset of the areas', () => {
    for (const area of Object.values(KIND_AREAS)) expect(singleArea([area])).toBe(area)
    expect(areaFaceKey('captures')).toBe('captures')
    expect(areaFaceKey('calendar')).toBeNull()
    expect(areaFaceKey(null)).toBeNull()
  })

  it('singleArea: the one area some skills agree on, else none', () => {
    expect(singleArea(['mail', null, 'mail'])).toBe('mail')
    expect(singleArea(['mail', 'crm'])).toBeNull()
    expect(singleArea([null, 'nope'])).toBeNull()
    expect(singleArea([])).toBeNull()
  })
})

describe('the recorder stamps it, and the notices carry it', () => {
  const base = { workspaceId: 'ws-1', memberId: 'm-1', title: 'Work' }

  it('writes the kind’s area on the row and hands it on the handle', async () => {
    const db = makeFakeSupabase({ project: true })
    const extraction = await startWork(db as never, { ...base, kind: WORK_KINDS.extraction, status: 'running' })
    const loop = await startWork(db as never, { ...base, kind: WORK_KINDS.flowRun, status: 'running', area: 'mail' })
    const plain = await startWork(db as never, { ...base, kind: WORK_KINDS.workRun, status: 'running' })
    const [a, b, c] = db.rows('tracked_job')
    expect(a.area).toBe('captures')
    expect(b.area).toBe('mail')
    // No area: the column is left to its default, as every writer inserted before.
    expect('area' in c).toBe(false)
    expect([extraction.area, loop.area, plain.area]).toEqual(['captures', 'mail', null])
  })

  it('a needs-you notice names the area beside its bot', async () => {
    const db = makeFakeSupabase({ project: true })
    db.seed('ai_team_member', [{ id: 'tm-mail', workspace_id: 'ws-1', system_key: 'mail', name: 'Mail', is_system: true }])
    const pass = await startWork(db as never, { ...base, kind: WORK_KINDS.emailDrafts, status: 'running', aiTeamMemberId: 'tm-mail' })
    await pass.finish({ summary: 'Drafted 1 reply', deliverables: [{ type: 'email_draft', id: 'd1', label: 'Re: A' }], review: { kind: 'review', verb: 'review' } })
    expect(hoisted.createNotification).toHaveBeenCalledTimes(1)
    const notice = hoisted.createNotification.mock.calls[0][0] as { metadata?: Record<string, unknown> }
    expect(notice.metadata).toMatchObject({ teammate_id: 'tm-mail', area: 'mail' })
  })

  it('a row with no teammate sends its notice from its area’s face, not the Assistant', async () => {
    const db = makeFakeSupabase({ project: true })
    db.seed('ai_team_member', [
      { id: 'tm-assistant', workspace_id: 'ws-1', system_key: 'assistant', name: 'Assistant', is_system: true },
      { id: 'tm-crm', workspace_id: 'ws-1', system_key: 'crm', name: 'CRM', is_system: true },
    ])
    const imp = await startWork(db as never, { ...base, kind: WORK_KINDS.crmImport, status: 'running' })
    await imp.fail('HubSpot said no')
    const notice = hoisted.createNotification.mock.calls[0][0] as { metadata?: Record<string, unknown> }
    expect(notice.metadata).toMatchObject({ teammate_id: 'tm-crm', area: 'crm' })
  })
})
