/**
 * Where a work run came from (B PR 4): recorded at the start, read back into
 * the brief with an excerpt of the capture, and only when the run's user may
 * still see that capture.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import { excerptAround, loadBriefSource, startProvenance } from '../provenance'

describe('startProvenance', () => {
  it('a proposal-backed card: the proposal’s capture and trigger quote', async () => {
    const fake = makeFakeSupabase()
    fake.seed('proposed_change', [{ id: 'p1', workspace_id: 'w1', capture_id: 'cap-p', trigger_quote: '  I’ll send Cori the SOW by Friday  ' }])
    expect(
      await startProvenance(fake as never, { workspaceId: 'w1', proposalId: 'p1', payload: { capture_id: 'cap-card' }, why: 'You said "something else entirely here"' }),
    ).toEqual({ captureId: 'cap-p', quote: 'I’ll send Cori the SOW by Friday' })
  })

  it('a proposal-less card: its own capture and the first quoted span of its why', async () => {
    const fake = makeFakeSupabase()
    expect(
      await startProvenance(fake as never, { workspaceId: 'w1', proposalId: null, payload: { capture_id: 'cap-card' }, why: 'Dana asked: “can you draft the kickoff note?” and “also the agenda”' }),
    ).toEqual({ captureId: 'cap-card', quote: 'can you draft the kickoff note?' })
  })

  it('nothing to point at: no provenance; a proposal in another workspace is not read', async () => {
    const fake = makeFakeSupabase()
    fake.seed('proposed_change', [{ id: 'p1', workspace_id: 'w2', capture_id: 'cap-x', trigger_quote: 'a quote from elsewhere' }])
    expect(await startProvenance(fake as never, { workspaceId: 'w1', proposalId: 'p1', payload: {}, why: 'no quotes here' })).toBeNull()
  })
})

describe('excerptAround', () => {
  const transcript =
    'Liam: thanks all. Dana: sure. Cori: Could you   draft the Q3\nkickoff note before Monday? It should cover hiring and the launch. Liam: will do.'

  it('finds the quote across whitespace and case, and keeps context on each side', () => {
    expect(excerptAround(transcript, 'could you draft the q3 kickoff note', 20)).toBe(
      '…. Dana: sure. Cori: Could you   draft the Q3\nkickoff note before Monday? It s…',
    )
    expect(excerptAround(transcript, 'Liam: thanks all', 5000)).toBe(transcript)
  })

  it('is null when the quote is not in the transcript', () => {
    expect(excerptAround(transcript, 'nothing like this was said')).toBeNull()
    expect(excerptAround('', 'anything')).toBeNull()
  })

  it('finds a quote the way the gate grounds it: across a speaker label, and an elided quote by its pieces', () => {
    const labelled = '[remote_1] Could you draft the Q3\n[local_1] kickoff note, please?\n[remote_1] Before Monday. It should cover hiring.'
    expect(excerptAround(labelled, 'could you draft the q3 kickoff note', 5)).toBe(
      '…e_1] Could you draft the Q3\n[local_1] kickoff note, ple…',
    )
    expect(excerptAround(labelled, 'draft the Q3 ... before Monday... it should cover hiring', 0)).toBe(
      '…draft the Q3\n[local_1] kickoff note, please?\n[remote_1] Before Monday. It should cover hiring…',
    )
    // A paraphrase is not found (no fuzzy matching).
    expect(excerptAround(labelled, 'could you write the Q3 kickoff note')).toBeNull()
  })
})

describe('loadBriefSource', () => {
  function world(captureOver: Record<string, unknown> = {}) {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      { id: 'job-1', workspace_id: 'w1', agent_run_id: 'run-1', source: { agent_run_id: 'run-1', provenance: { captureId: 'cap-1', quote: 'draft the Q3 kickoff note' } } },
      { id: 'job-2', workspace_id: 'w1', agent_run_id: 'run-2', source: { agent_run_id: 'run-2' } },
    ])
    fake.seed('captures', [
      {
        id: 'cap-1',
        workspace_id: 'w1',
        title: 'Sync w/ Cori',
        transcript: 'Cori: could you draft the Q3 kickoff note before Monday?',
        visibility: 'workspace',
        user_id: 'owner',
        is_eval: false,
        ...captureOver,
      },
    ])
    return fake
  }

  it('the quote, the capture and the excerpt around it', async () => {
    expect(await loadBriefSource(world() as never, { workspaceId: 'w1', agentRunId: 'run-1', triggeredBy: 'u1' })).toEqual({
      quote: 'draft the Q3 kickoff note',
      captureId: 'cap-1',
      captureTitle: 'Sync w/ Cori',
      excerpt: 'Cori: could you draft the Q3 kickoff note before Monday?',
    })
  })

  it('a capture the run’s user cannot see: the quote rides, the capture and its transcript do not', async () => {
    const fake = world({ visibility: 'private', user_id: 'someone-else' })
    expect(await loadBriefSource(fake as never, { workspaceId: 'w1', agentRunId: 'run-1', triggeredBy: 'u1' })).toEqual({
      quote: 'draft the Q3 kickoff note',
      captureId: null,
      captureTitle: null,
      excerpt: null,
    })
    const own = world({ visibility: 'private', user_id: 'u1' })
    expect((await loadBriefSource(own as never, { workspaceId: 'w1', agentRunId: 'run-1', triggeredBy: 'u1' }))?.excerpt).toContain('kickoff note')
  })

  it('no provenance on the row, or no row: nothing', async () => {
    expect(await loadBriefSource(world() as never, { workspaceId: 'w1', agentRunId: 'run-2', triggeredBy: 'u1' })).toBeUndefined()
    expect(await loadBriefSource(world() as never, { workspaceId: 'w1', agentRunId: 'missing', triggeredBy: 'u1' })).toBeUndefined()
  })
})
