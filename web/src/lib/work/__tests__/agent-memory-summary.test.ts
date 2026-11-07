/**
 * The settle-time summariser (plan row 15). Pins: only a completed work run
 * done as this teammate, and only once, is summarised; the model sees the
 * task, the run's report, deliverable LABELS (never ids or contents), touch
 * counts and what the teammate already remembers; every capture the run read
 * or came from is recorded on its entries; the writer keeps at most three,
 * drops repeats, lets an entry supersede the one it replaces (salience + 1),
 * never writes a run twice, and retires the weakest past the cap.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase } from './fake-supabase'
import { MEMORY_ACTIVE_CAP } from '../agent-memory'
import {
  applyMemorySummary,
  buildSummaryMessage,
  loadSummaryInput,
  type SummaryInput,
} from '../agent-memory-summary'

const WS = 'ws-1'
const MATE = 'mate-1'
const RUN = 'run-1'

function seedRun(db: ReturnType<typeof makeFakeSupabase>, over: Record<string, unknown> = {}) {
  db.seed('agent_run', [
    {
      id: RUN,
      workspace_id: WS,
      kind: 'workspace',
      status: 'completed',
      ai_team_member_id: MATE,
      triggered_by: 'user-1',
      task_prompt: 'Draft the Q3 kickoff note for Dana covering hiring and the launch.',
      result_summary: 'Drafted the kickoff note as three bullets, as Dana asked last time.',
      deliverables: [{ type: 'document', id: 'doc-1', label: 'Q3 kickoff note' }],
      resources: [{ type: 'capture', id: 'cap-res', label: 'Kickoff call' }, { type: 'project', id: 'p-1', label: 'Q3' }],
      ...over,
    },
  ])
  db.seed('ai_team_member', [{ id: MATE, workspace_id: WS, name: 'Quill', role: 'writer' }])
  db.seed('work_touch', [
    { agent_run_id: RUN, workspace_id: WS, entity_type: 'document', entity_id: 'doc-1', verb: 'created' },
    { agent_run_id: RUN, workspace_id: WS, entity_type: 'capture', entity_id: 'cap-read', verb: 'read' },
    { agent_run_id: RUN, workspace_id: WS, entity_type: 'capture', entity_id: 'cap-read', verb: 'read' },
    { agent_run_id: RUN, workspace_id: WS, entity_type: 'contact', entity_id: 'c-1', verb: 'read' },
    { agent_run_id: 'other-run', workspace_id: WS, entity_type: 'contact', entity_id: 'c-9', verb: 'read' },
  ])
  db.seed('tracked_job', [{ id: 'job-1', agent_run_id: RUN, workspace_id: WS, source: { provenance: { captureId: 'cap-src', quote: 'q' } } }])
}

const load = (db: ReturnType<typeof makeFakeSupabase>) =>
  loadSummaryInput(db as unknown as SupabaseClient, { agentRunId: RUN, workspaceId: WS, teammateId: MATE })

describe('loadSummaryInput', () => {
  it('reads the finished work back, with every capture it read or came from', async () => {
    const db = makeFakeSupabase()
    seedRun(db)
    db.seed('agent_memory', [
      { id: 'mem-1', workspace_id: WS, ai_team_member_id: MATE, kind: 'preference', text: 'Dana likes bullets.', salience: 2, status: 'active', created_at: '2026-09-01T00:00:00Z' },
      { id: 'mem-x', workspace_id: WS, ai_team_member_id: MATE, kind: 'fact', text: 'Old.', salience: 1, status: 'superseded', created_at: '2026-09-01T00:00:00Z' },
    ])
    const res = await load(db)
    if (!('input' in res)) throw new Error(`skipped: ${res.skip}`)
    const input = res.input
    expect(input.teammate).toEqual({ name: 'Quill', role: 'writer' })
    expect(input.userId).toBe('user-1')
    expect(input.deliverables).toEqual([{ type: 'document', label: 'Q3 kickoff note' }])
    expect(input.touches).toEqual([
      { type: 'document', id: 'doc-1', verb: 'created' },
      { type: 'capture', id: 'cap-read', verb: 'read' },
      { type: 'contact', id: 'c-1', verb: 'read' },
    ])
    expect(input.captureIds.sort()).toEqual(['cap-read', 'cap-res', 'cap-src'])
    expect(input.workItemId).toBe('job-1')
    expect(input.existing.map((m) => m.id)).toEqual(['mem-1'])
    // No origin (a row from before the column): only 'user' is the person's Start.
    expect(input.sourceClass).toBe('agent_unattended')
  })

  it('stamps who asked for the run: a person\u2019s Start, or unattended for anything else', async () => {
    for (const [origin, expected] of [['user', 'person'], ['attempt', 'agent_unattended'], ['loop', 'agent_unattended'], ['chat', 'agent_unattended'], ['delegation', 'agent_unattended']] as const) {
      const db = makeFakeSupabase()
      seedRun(db, { origin })
      const res = await load(db)
      if (!('input' in res)) throw new Error(`skipped: ${res.skip}`)
      expect(res.input.sourceClass, origin).toBe(expected)
    }
  })

  it('skips a run that is not completed, not this teammate’s, or already summarised', async () => {
    let db = makeFakeSupabase()
    seedRun(db, { status: 'failed' })
    expect(await load(db)).toEqual({ skip: 'not a completed work run' })
    db = makeFakeSupabase()
    seedRun(db, { ai_team_member_id: 'mate-2' })
    expect(await load(db)).toEqual({ skip: 'teammate changed' })
    db = makeFakeSupabase()
    seedRun(db)
    db.seed('agent_memory', [{ id: 'mem-9', agent_run_id: RUN, workspace_id: WS, ai_team_member_id: MATE, status: 'active' }])
    expect(await load(db)).toEqual({ skip: 'already summarised' })
  })
})

const INPUT: SummaryInput = {
  agentRunId: RUN,
  workspaceId: WS,
  teammateId: MATE,
  userId: 'user-1',
  teammate: { name: 'Quill', role: 'writer' },
  task: 'Draft the Q3 kickoff note.',
  summary: 'Drafted it as bullets.',
  deliverables: [{ type: 'document', label: 'Q3 kickoff note' }],
  touches: [
    { type: 'document', id: 'doc-1', verb: 'created' },
    { type: 'contact', id: 'c-1', verb: 'read' },
    { type: 'contact', id: 'c-2', verb: 'read' },
  ],
  workItemId: 'job-1',
  captureIds: ['cap-src'],
  existing: [
    { id: 'mem-1', kind: 'preference', text: 'Dana likes bullets.', salience: 2 },
    { id: 'mem-2', kind: 'fact', text: 'The launch is in October.', salience: 1 },
  ],
  // A run the person started: its entries are written (trusted writes).
  sourceClass: 'person',
}

describe('buildSummaryMessage', () => {
  it('gives the work as data — labels, not ids — and keys what is remembered', () => {
    const msg = buildSummaryMessage(INPUT)
    expect(msg).toContain('Teammate: Quill (writer)')
    expect(msg).toContain('Draft the Q3 kickoff note.')
    expect(msg).toContain('Drafted it as bullets.')
    expect(msg).toContain('- document: Q3 kickoff note')
    expect(msg).toContain('- created 1 document')
    expect(msg).toContain('- read 2 contacts')
    expect(msg).toContain('m1 [preference] Dana likes bullets.')
    expect(msg).toContain('m2 [fact] The launch is in October.')
    expect(msg).not.toContain('doc-1')
    expect(msg).not.toContain('cap-src')
  })
})

describe('applyMemorySummary', () => {
  const apply = (db: ReturnType<typeof makeFakeSupabase>, entries: Array<{ kind: 'fact' | 'preference' | 'lesson'; text: string; replaces: string | null }>, input = INPUT) =>
    applyMemorySummary(db as unknown as SupabaseClient, input, { entries })

  function seedExisting(db: ReturnType<typeof makeFakeSupabase>) {
    db.seed('agent_memory', [
      { id: 'mem-1', workspace_id: WS, ai_team_member_id: MATE, kind: 'preference', text: 'Dana likes bullets.', salience: 2, status: 'active', created_at: '2026-09-01T00:00:00Z' },
      { id: 'mem-2', workspace_id: WS, ai_team_member_id: MATE, kind: 'fact', text: 'The launch is in October.', salience: 1, status: 'active', created_at: '2026-09-02T00:00:00Z' },
    ])
  }

  it('writes at most three, drops repeats, and records where each came from', async () => {
    const db = makeFakeSupabase()
    seedExisting(db)
    const res = await apply(db, [
      { kind: 'fact', text: '  The launch  is in October. ', replaces: null },
      { kind: 'lesson', text: 'Check the hiring plan doc before drafting a kickoff note.', replaces: null },
      { kind: 'lesson', text: 'check the hiring plan doc before drafting a kickoff note.', replaces: null },
      { kind: 'fact', text: 'Priya owns the Q3 launch.', replaces: null },
      { kind: 'preference', text: 'Dana wants the owner named on each bullet.', replaces: null },
      { kind: 'fact', text: 'A fifth one.', replaces: null },
    ])
    expect(res).toEqual({ inserted: 3, superseded: 0, retired: 0 })
    const fresh = db.rows('agent_memory').filter((r) => r.agent_run_id === RUN)
    expect(fresh.map((r) => r.text)).toEqual([
      'Check the hiring plan doc before drafting a kickoff note.',
      'Priya owns the Q3 launch.',
      'Dana wants the owner named on each bullet.',
    ])
    expect(fresh[0]).toMatchObject({
      workspace_id: WS,
      ai_team_member_id: MATE,
      salience: 1,
      status: 'active',
      source: {
        work_item_id: 'job-1',
        entities: [{ type: 'document', id: 'doc-1' }, { type: 'contact', id: 'c-1' }, { type: 'contact', id: 'c-2' }],
        capture_ids: ['cap-src'],
        trust: 'person',
      },
    })
  })

  it('an entry that replaces a remembered one supersedes it and carries its salience + 1', async () => {
    const db = makeFakeSupabase()
    seedExisting(db)
    const res = await apply(db, [
      { kind: 'preference', text: 'Dana likes three bullets, owner first.', replaces: 'm1' },
      { kind: 'preference', text: 'Dana likes bullets with dates.', replaces: 'm1' },
      { kind: 'fact', text: 'Someone else.', replaces: 'm9' },
    ])
    expect(res.superseded).toBe(1)
    const rows = db.rows('agent_memory')
    const updated = rows.find((r) => r.text === 'Dana likes three bullets, owner first.')!
    expect(updated.salience).toBe(3)
    expect(rows.find((r) => r.id === 'mem-1')).toMatchObject({ status: 'superseded', superseded_by: updated.id })
    // The second claim on m1 and an unknown key write as plain new entries.
    expect(rows.find((r) => r.text === 'Dana likes bullets with dates.')!.salience).toBe(1)
    expect(rows.find((r) => r.text === 'Someone else.')!.salience).toBe(1)
    expect(rows.find((r) => r.id === 'mem-2')!.status).toBe('active')
  })

  it('never writes a run twice, and writes nothing for an empty answer', async () => {
    const db = makeFakeSupabase()
    expect(await apply(db, [])).toEqual({ inserted: 0, superseded: 0, retired: 0 })
    await apply(db, [{ kind: 'fact', text: 'Priya owns the Q3 launch.', replaces: null }])
    const again = await apply(db, [{ kind: 'fact', text: 'Something new.', replaces: null }])
    expect(again.alreadyWritten).toBe(true)
    expect(db.rows('agent_memory')).toHaveLength(1)
  })

  it('retires the least reinforced, oldest entries past the cap', async () => {
    const db = makeFakeSupabase()
    db.seed(
      'agent_memory',
      Array.from({ length: MEMORY_ACTIVE_CAP }, (_, i) => ({
        id: `old-${i}`,
        workspace_id: WS,
        ai_team_member_id: MATE,
        kind: 'fact',
        text: `fact ${i}`,
        salience: i === 0 ? 5 : 1,
        status: 'active',
        created_at: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`,
      })),
    )
    const res = await apply(db, [{ kind: 'fact', text: 'Brand new.', replaces: null }], { ...INPUT, existing: [] })
    expect(res.retired).toBe(1)
    const retired = db.rows('agent_memory').filter((r) => r.status === 'retired').map((r) => r.id)
    // old-1 is the oldest of the salience-1 entries; old-0 is oldest but reinforced.
    expect(retired).toEqual(['old-1'])
  })
})

describe('loadSummaryInput: what outside text the run read (migration 374)', () => {
  it('reads the run’s record, and the outside-text tools its log tail names should a note be lost', async () => {
    const db = makeFakeSupabase()
    seedRun(db, { outside_reads: ['read_email'], log_tail: '[tool] list_actions, web_fetch\n' })
    const res = await load(db)
    if (!('input' in res)) throw new Error(`skipped: ${res.skip}`)
    expect(res.input.outsideReads?.sort()).toEqual(['read_email', 'web_fetch'])
    expect(res.input.origin).toBeNull()
  })

  it('a run that read none has nothing to label', async () => {
    const db = makeFakeSupabase()
    seedRun(db, { outside_reads: [], log_tail: '[tool] list_actions\n' })
    const res = await load(db)
    if (!('input' in res)) throw new Error(`skipped: ${res.skip}`)
    expect(res.input.outsideReads).toEqual([])
  })
})

describe('applyMemorySummary: always written active, labelled when the run read outside text (decision 16, apply with undo)', () => {
  const apply = (db: ReturnType<typeof makeFakeSupabase>, entries: Array<{ kind: 'fact' | 'preference' | 'lesson'; text: string; replaces: string | null }>, input: SummaryInput) =>
    applyMemorySummary(db as unknown as SupabaseClient, input, { entries })
  function seedExisting(db: ReturnType<typeof makeFakeSupabase>) {
    db.seed('agent_memory', [
      { id: 'mem-1', workspace_id: WS, ai_team_member_id: MATE, kind: 'preference', text: 'Dana likes bullets.', salience: 2, status: 'active', created_at: '2026-09-01T00:00:00Z' },
      { id: 'mem-2', workspace_id: WS, ai_team_member_id: MATE, kind: 'fact', text: 'The launch is in October.', salience: 1, status: 'active', created_at: '2026-09-02T00:00:00Z' },
    ])
  }
  const ATTEMPT: SummaryInput = { ...INPUT, sourceClass: 'agent_unattended', origin: 'attempt', outsideReads: [] }
  const READ_THE_WEB: SummaryInput = { ...ATTEMPT, outsideReads: ['web_fetch', 'read_email'] }

  it('an attempted run that read no outside text writes active, recorded with its origin and trust class', async () => {
    const db = makeFakeSupabase()
    seedExisting(db)
    const res = await apply(db, [{ kind: 'preference', text: 'Dana likes three bullets, owner first.', replaces: 'm1' }], ATTEMPT)
    expect(res).toEqual({ inserted: 1, superseded: 1, retired: 0 })
    const fresh = db.rows('agent_memory').find((r) => r.agent_run_id === RUN)!
    expect(fresh).toMatchObject({ status: 'active', source: { trust: 'agent_unattended', origin: 'attempt' } })
    expect(fresh.source).not.toHaveProperty('outside_reads')
  })

  it('a run that read outside text writes its entries ACTIVE too, naming the tools for the label, and supersedes as any run does', async () => {
    const db = makeFakeSupabase()
    seedExisting(db)
    const res = await apply(db, [
      { kind: 'preference', text: 'Dana likes three bullets, owner first.', replaces: 'm1' },
      { kind: 'fact', text: 'Priya owns the Q3 launch.', replaces: null },
    ], READ_THE_WEB)
    expect(res).toEqual({ inserted: 2, superseded: 1, retired: 0 })
    const fresh = db.rows('agent_memory').filter((r) => r.agent_run_id === RUN)
    expect(fresh.map((r) => r.status)).toEqual(['active', 'active'])
    expect(fresh[0].source).toMatchObject({ trust: 'agent_unattended', origin: 'attempt', outside_reads: ['web_fetch', 'read_email'] })
    expect(db.rows('agent_memory').find((r) => r.id === 'mem-1')!.status).toBe('superseded')
    // Nothing is ever written to wait for someone.
    expect(db.rows('agent_memory').some((r) => r.status === 'proposed')).toBe(false)
  })

  it('a person-started run that read outside text is written and labelled the same way', async () => {
    const db = makeFakeSupabase()
    await apply(db, [{ kind: 'fact', text: 'Priya owns the Q3 launch.', replaces: null }], { ...INPUT, outsideReads: ['ingest_reference'] })
    expect(db.rows('agent_memory')[0]).toMatchObject({ status: 'active', source: { trust: 'person', outside_reads: ['ingest_reference'] } })
  })

  it('an input loaded before this existed (no outside reads, no class) writes active, recorded unattended', async () => {
    const db = makeFakeSupabase()
    const { sourceClass: _class, ...legacy } = INPUT
    await applyMemorySummary(db as unknown as SupabaseClient, legacy, { entries: [{ kind: 'fact', text: 'Priya owns the Q3 launch.', replaces: null }] })
    expect(db.rows('agent_memory')[0]).toMatchObject({ status: 'active', source: { trust: 'agent_unattended' } })
  })
})
