// @vitest-environment jsdom
/**
 * The delegate's work on the action's surfaces (decision 9):
 *   - the action panel's plan (ActionJobPlan): the job's checklist, live, with
 *     Stop through the action's run cancel route; a teammate who can't read
 *     the job (owner-only RLS) sees "Working" while the run is live;
 *   - the row's "step 3 of 5" (DelegateWorkBadge), off the shell's shared rows;
 *   - the assignee cell (MemberCellTrigger): the person leads, the delegate
 *     agent rides as a chip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  job: null as Record<string, unknown> | null,
  onRow: null as ((row: Record<string, unknown>) => void) | null,
  filter: null as string | null,
  rows: null as Array<Record<string, unknown>> | null,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: hoisted.job, error: null })
      return b
    },
  }),
}))
vi.mock('@/hooks/use-row-changes', () => ({
  useRowChanges: (opts: { filter: string | null; onRow: (row: Record<string, unknown>) => void }) => {
    hoisted.filter = opts.filter
    hoisted.onRow = opts.onRow
  },
}))
vi.mock('../agent-work-provider', () => ({
  useOptionalAgentWork: () => (hoisted.rows ? { work: { rows: hoisted.rows }, counts: new Map() } : null),
}))

import { ActionJobPlan } from '../action-job-plan'
import { DelegateWorkBadge, delegateBadgeFor, delegateStepsFor, delegateWorkerFor } from '../delegate-work-badge'
import { MemberCellTrigger } from '@/components/views/properties/member-picker'

const PLAN = {
  steps: [
    { text: 'Read the thread', status: 'done' },
    { text: 'Draft the reply', status: 'in_progress' },
    { text: 'Check the numbers', status: 'pending' },
  ],
  updated_at: '2026-10-14T00:00:00Z',
}

let container: HTMLDivElement
let root: Root
const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{}'))

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  hoisted.job = null
  hoisted.onRow = null
  hoisted.filter = null
  hoisted.rows = null
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(el: ReturnType<typeof h>) {
  await act(async () => {
    root.render(el)
  })
  await act(async () => {})
}

describe('ActionJobPlan', () => {
  it('shows the job’s plan with the step it is on, on one row binding, and Stop cancels the run', async () => {
    hoisted.job = { id: 'job-1', status: 'running', plan: PLAN }
    await render(h(ActionJobPlan, { actionId: 'act-1', agentRunId: 'run-1', runLive: true }))
    expect(hoisted.filter).toBe('agent_run_id=eq.run-1')
    expect(container.textContent).toContain('Plan')
    expect(container.textContent).toContain('step 2 of 3')
    expect(container.querySelectorAll('[data-plan-step]')).toHaveLength(3)

    // The agent rewrites its plan: the checklist follows the pushed row.
    await act(async () => {
      hoisted.onRow?.({ id: 'job-1', status: 'running', plan: { ...PLAN, steps: PLAN.steps.map((s) => ({ ...s, status: 'done' })) } })
    })
    expect(container.textContent).toContain('step 3 of 3')

    const stop = container.querySelector('button[aria-label="Stop the agent\'s job"]') as HTMLButtonElement
    await act(async () => {
      stop.click()
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/account/actions/act-1/agent-runs/run-1/cancel', { method: 'POST' })
  })

  it('a settled job keeps its plan, still and without Stop', async () => {
    hoisted.job = { id: 'job-1', status: 'needs_review', plan: PLAN }
    await render(h(ActionJobPlan, { actionId: 'act-1', agentRunId: 'run-1', runLive: false }))
    expect(container.querySelectorAll('[data-plan-step]')).toHaveLength(3)
    expect(container.querySelector('button[aria-label="Stop the agent\'s job"]')).toBeNull()
  })

  it('a teammate who can’t read the job sees "Working" while the run is live, and nothing after', async () => {
    hoisted.job = null
    await render(h(ActionJobPlan, { actionId: 'act-1', agentRunId: 'run-1', runLive: true }))
    expect(container.textContent).toContain('Working')
    await render(h(ActionJobPlan, { actionId: 'act-1', agentRunId: 'run-1', runLive: false }))
    expect(container.textContent).toBe('')
  })

  it('no run, no binding', async () => {
    await render(h(ActionJobPlan, { actionId: 'act-1', agentRunId: null, runLive: false }))
    expect(hoisted.filter).toBeNull()
    expect(container.textContent).toBe('')
  })
})

describe('DelegateWorkBadge', () => {
  it('finds the live job working the action and reads its step', () => {
    const rows = [
      { status: 'done', source: { action_id: 'act-1' }, plan: PLAN },
      { status: 'running', source: { action_id: 'act-1' }, plan: PLAN },
    ]
    expect(delegateStepsFor(rows, 'act-1')).toHaveLength(3)
    expect(delegateStepsFor(rows, 'act-2')).toBeNull()
    expect(delegateStepsFor([{ status: 'done', source: { action_id: 'act-1' }, plan: PLAN }], 'act-1')).toBeNull()
  })

  it('the job’s owner sees "step 2 of 3"', async () => {
    hoisted.rows = [{ status: 'running', source: { action_id: 'act-1' }, plan: PLAN }]
    await render(h(DelegateWorkBadge, { actionId: 'act-1', agentRunStatus: 'working' }))
    expect(container.textContent).toBe('step 2 of 3')
  })

  it('a teammate sees "working" while the run is live, and nothing once it stops', async () => {
    hoisted.rows = []
    await render(h(DelegateWorkBadge, { actionId: 'act-1', agentRunStatus: 'working' }))
    expect(container.textContent).toBe('working')
    await render(h(DelegateWorkBadge, { actionId: 'act-1', agentRunStatus: 'idle' }))
    expect(container.textContent).toBe('')
  })
})

describe('DelegateWorkBadge: a job on the person’s own coding agent (migration 658)', () => {
  it('finds the live Mac job’s agent by the action its Start made it for', () => {
    const rows = [
      { status: 'done', source: { local_agent_action_id: 'act-1', worker: 'codex' } },
      { status: 'running', source: { local_agent_action_id: 'act-1', worker: 'claude-code' } },
      { status: 'running', source: { local_agent_action_id: 'act-2' } },
    ]
    expect(delegateWorkerFor(rows, 'act-1')).toBe('claude-code')
    expect(delegateWorkerFor(rows, 'act-2')).toBeNull()
    expect(delegateWorkerFor([{ status: 'running', source: { local_agent_action_id: 'act-1', worker: 'Not An Id' } }], 'act-1')).toBeNull()
  })

  it('names the agent beside where the job stands, on a board card as on a row', async () => {
    hoisted.rows = [{ status: 'running', source: { local_agent_action_id: 'act-1', worker: 'claude-code' } }]
    await render(h(DelegateWorkBadge, { actionId: 'act-1', agentRunStatus: 'working' }))
    expect(container.textContent).toBe('Claude Code · working')
    expect(container.querySelector('[data-delegate-worker]')?.getAttribute('data-delegate-worker')).toBe('claude-code')
    // Our own agent on the Mac, or a cloud run: as before.
    hoisted.rows = [{ status: 'running', source: { local_agent_action_id: 'act-1' } }]
    await render(h(DelegateWorkBadge, { actionId: 'act-1', agentRunStatus: 'working' }))
    expect(container.textContent).toBe('working')
  })
})

describe('DelegateWorkBadge: what a person needs to know, most urgent first (rows and board cards alike)', () => {
  const mac = (status: string, worker?: string) => ({ status, source: { local_agent_action_id: 'act-1', ...(worker ? { worker } : {}) } })
  const text = (rows: Array<Record<string, unknown>>, runStatus: string | null) => {
    const b = delegateBadgeFor(rows as never, 'act-1', runStatus)
    return b ? `${b.state}: ${b.text}${b.worker ? ` (${b.worker})` : ''}` : null
  }

  it('needs you beats everything: a Mac job’s question, or the action’s run asking', () => {
    expect(text([mac('needs_input', 'claude-code'), mac('running')], 'working')).toBe('needs_you: needs you (claude-code)')
    expect(text([{ status: 'needs_input', source: { action_id: 'act-1' }, plan: PLAN }], 'working')).toBe('needs_you: needs you')
    // A teammate holds no rows: the action's run status says it.
    expect(text([], 'needs_input')).toBe('needs_you: needs you')
  })

  it('working: our own agent’s planned run counts its steps; the person’s own agent is named', () => {
    expect(text([{ status: 'running', source: { action_id: 'act-1' }, plan: PLAN }], 'working')).toBe('working: step 2 of 3')
    expect(text([mac('running', 'codex')], 'working')).toBe('working: working (codex)')
    expect(text([], 'starting')).toBe('working: working')
  })

  it('a job waiting for a slot on the Mac (or for the Mac): queued, unless another of its jobs works', () => {
    expect(text([mac('queued', 'claude-code')], 'working')).toBe('queued: queued (claude-code)')
    // Its Mac named where the row knows it: one word through the server's line and the Mac's.
    expect(text([{ status: 'queued', source: { local_agent_action_id: 'act-1', device_name: 'Studio Mac' } }], 'working')).toBe('queued: queued on Studio Mac')
    expect(text([mac('queued'), mac('running')], 'working')).toBe('working: working')
    expect(text([mac('queued'), mac('needs_input')], 'working')).toBe('needs_you: needs you')
  })

  it('a finished job that left something to look at: ready to review; then PR open; then failed', () => {
    expect(text([mac('needs_review', 'claude-code')], 'idle')).toBe('ready_to_review: ready to review (claude-code)')
    expect(text([], 'pr_open')).toBe('pr_open: PR open')
    expect(text([], 'failed')).toBe('failed: failed')
    expect(text([mac('done', 'claude-code')], 'idle')).toBeNull()
    expect(text([], null)).toBeNull()
  })

  it('renders the state it chose', async () => {
    hoisted.rows = [mac('needs_input', 'claude-code')]
    await render(h(DelegateWorkBadge, { actionId: 'act-1', agentRunStatus: 'working' }))
    expect(container.textContent).toBe('Claude Code · needs you')
    expect(container.querySelector('[data-delegate-work]')!.getAttribute('data-delegate-work')).toBe('needs_you')
    hoisted.rows = []
    await render(h(DelegateWorkBadge, { actionId: 'act-1', agentRunStatus: 'pr_open' }))
    expect(container.textContent).toBe('PR open')
  })
})

describe('MemberCellTrigger with a delegate', () => {
  const members = [
    { id: 'mem-1', display_name: 'Ada Lovelace', avatar_url: null, kind: 'member' as const },
    { id: 'ai-1', display_name: 'Writer', avatar_url: null, kind: 'ai' as const },
  ]

  it('the person leads and the agent rides as a chip', async () => {
    await render(
      h(MemberCellTrigger, {
        value: 'mem-1',
        members,
        onChange: () => {},
        delegate: { id: 'ai-1', name: 'Writer', avatar: null },
      }),
    )
    const button = container.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('Assigned to Ada Lovelace, delegated to Writer')
    expect(container.querySelector('[data-delegate-chip]')).not.toBeNull()
  })

  it('an agent with nobody responsible stands alone, with no chip', async () => {
    await render(h(MemberCellTrigger, { value: null, members, onChange: () => {}, delegate: { id: 'ai-1', name: 'Writer', avatar: null } }))
    expect(container.querySelector('button')!.getAttribute('aria-label')).toBe('Assigned to Writer')
    expect(container.querySelector('[data-delegate-chip]')).toBeNull()
  })
})
