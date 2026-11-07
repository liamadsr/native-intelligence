/**
 * A loop's saved instructions for the reviewer (A5): its run_skill step's
 * instructions on the skill-run door, and its run_local_agent step's saved
 * request on the Mac-job door (only while the loop is still the job's
 * person's), fenced to the run's workspace; never the loop's name or
 * description, and the skill's name alone is never treated as an instruction.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { describeLoop, localAgentLoopInstructions, skillRunLoopInstructions } from '../loop-instructions'

const WS = 'ws-1'
let db: FakeSupabase
const flow = { id: 'flow-1', workspace_id: WS, name: 'Bug sync', description: 'Weekly', actions: [
  { type: 'run_skill', config: { skill_id: 'skill-1', instructions: 'Push new bugs to Linear.' } },
  { type: 'run_skill', config: { skill_id: 'other', instructions: 'Ignore me.' } },
] }

beforeEach(() => {
  db = makeFakeSupabase()
  db.seed('recipe', [{ id: 'skill-1', name: 'Triage', workspace_id: WS, is_system: false }, { id: 'foreign-skill', name: 'Theirs', workspace_id: 'ws-2', is_system: false }])
  db.seed('flow', [flow])
  db.seed('flow_run', [{ id: 'run-1', flow_id: 'flow-1' }])
  db.seed('tracked_job', [{ id: 'job-1', workspace_id: WS, flow_run_id: 'run-1' }])
})

describe('describeLoop', () => {
  it('this skill\'s step instructions, never another step\'s, and never the member-editable name or description (S9)', () => {
    expect(describeLoop(flow, 'skill-1')).toBe('Instructions: Push new bugs to Linear.')
  })

  it('a skill name alone is no instruction (the reviewer then blocks as no_request)', () => {
    expect(describeLoop(null, 'skill-1')).toBeNull()
  })
})

describe('skillRunLoopInstructions', () => {
  it('reads the flow the run token’s flow step names, while its ledger row has no flow run yet (every live dispatch)', async () => {
    db.seed('tracked_job', [{ id: 'job-live', workspace_id: WS, flow_run_id: null }])
    expect(await skillRunLoopInstructions(db as never, { workspaceId: WS, skillId: 'skill-1', workItemId: 'job-live', flowStep: { flowId: 'flow-1' } }))
      .toEqual(['Instructions: Push new bugs to Linear.'])
    // A manual Test or a resumed run has no ledger row: the flow step alone is enough.
    expect(await skillRunLoopInstructions(db as never, { workspaceId: WS, skillId: 'skill-1', flowStep: { flowId: 'flow-1' } })).toHaveLength(1)
    // Never another workspace's flow.
    expect(await skillRunLoopInstructions(db as never, { workspaceId: 'ws-2', skillId: 'skill-1', flowStep: { flowId: 'flow-1' } })).toEqual([])
  })

  it('follows the ledger row to the flow', async () => {
    expect(await skillRunLoopInstructions(db as never, { workspaceId: WS, skillId: 'skill-1', workItemId: 'job-1' }))
      .toEqual(['Instructions: Push new bugs to Linear.'])
  })

  it('with no ledger row there are no words (not the skill name)', async () => {
    expect(await skillRunLoopInstructions(db as never, { workspaceId: WS, skillId: 'skill-1' })).toEqual([])
  })

  it('never reads another workspace\'s flow', async () => {
    expect(await skillRunLoopInstructions(db as never, { workspaceId: 'ws-2', skillId: 'skill-1', workItemId: 'job-1' })).toEqual([])
  })
})

describe('localAgentLoopInstructions', () => {
  const ids = { workspaceId: WS, flowId: 'flow-mac', actionId: 'step-1', userId: 'user-1' }
  beforeEach(() => {
    db.seed('flow', [{ id: 'flow-mac', workspace_id: WS, created_by: 'user-1', name: 'Nightly', description: 'CI', actions: [
      { id: 'step-1', type: 'run_local_agent', config: { folder_id: 'folder-1', request: 'Check CI', mode: 'edit' } },
    ] }])
  })

  it("the step's saved request while the loop is still the job's person's", async () => {
    expect(await localAgentLoopInstructions(db as never, ids)).toEqual([
      "Loop step: a job on the person's Mac (may edit files in a git worktree): Check CI",
    ])
  })

  it("no words once the loop is another member's, or in another workspace (the reviewer then blocks)", async () => {
    expect(await localAgentLoopInstructions(db as never, { ...ids, userId: 'user-2' })).toEqual([])
    expect(await localAgentLoopInstructions(db as never, { ...ids, workspaceId: 'ws-2' })).toEqual([])
    expect(await localAgentLoopInstructions(db as never, { ...ids, actionId: 'step-gone' })).toEqual([])
  })
})
