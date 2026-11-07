import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatSpec } from '../spec-client'

/**
 * Quick helpers (A4 slice 3): the plain-data half of the blocking `helpers`
 * tool (tools/helpers.ts). The workflow body itself can't run here (vitest
 * can't resolve eve's vendored `workflow`), so everything it computes lives in
 * lib/helpers.ts, lib/helpers-tasks.ts and lib/helpers-prepare.ts and is pinned here: the input
 * bounds, the gate, the task messages with their playbooks, the progress
 * snapshots, the deadline and the result assembly.
 */

vi.mock('eve/context', () => ({
  defineState: <T,>(_name: string, initial: () => T) => ({ get: initial, update: () => {} }),
}))

const fetchChatSpec = vi.fn<(t: string, c: string, o?: { skills?: boolean }) => Promise<ChatSpec | null>>()
const fetchHelperTiers = vi.fn<(t: string, c: string, tasks: string[], models?: ReadonlyArray<string | null>) => Promise<unknown[] | null>>(async () => null)
vi.mock('../spec-client', () => ({
  fetchChatSpec: (...a: [string, string, { skills?: boolean }?]) => fetchChatSpec(...a),
  fetchHelperTiers: (...a: [string, string, string[], ReadonlyArray<string | null>?]) => fetchHelperTiers(...a),
  runTokenFromAuth: (auth: { current?: { attributes?: { chatRunToken?: string } } }) => auth.current?.attributes?.chatRunToken ?? '',
  turnCtxFromAuth: () => 'ENC',
}))

import {
  HELPER_RESULT_MAX_CHARS,
  assembleHelperResults,
  deadlineDuration,
  helperAgentsFor,
  helperErrorText,
  helperOutputText,
  helperTaskMessage,
  helperTurnSettlement,
  helpersInputSchema,
  helpersProgress,
  isSteerInterrupt,
  refusedHelpers,
  unrecognisedAbortReason,
  type HelperSettlement,
} from '../helpers'
import { prepareHelperTasks, skillBlocksFor } from '../helpers-tasks'
import { prepareHelpers } from '../helpers-prepare'

const baseSpec = (extra: Partial<ChatSpec> = {}): ChatSpec => ({
  systemPrompt: 'SP',
  model: 'm',
  ceiling: null,
  ceilingTools: [],
  coreToolNames: [],
  helpersAllowed: true,
  helperToolNames: ['find'],
  ...extra,
})

const MAIL_PACK = { area: 'mail', name: 'Mail', playbookSkill: 'mail-playbook', toolNames: ['list_emails'], cardKinds: [], markdown: '# Mail\nTriage by sender.' }

beforeEach(() => fetchChatSpec.mockReset())

describe('what the workflow body imports stays Workflow-VM safe (eve build fails otherwise)', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')
  const valueImports = (src: string) => [...src.matchAll(/^import (?!type )[^;']*? from '([^']+)'/gm)].map((m) => m[1])

  it('lib/helpers.ts imports nothing but zod', () => {
    expect(valueImports(read('helpers.ts'))).toEqual(['zod'])
  })

  it('lib/helpers-prepare.ts holds the one step and nothing else, so eve strips its imports from the bundle', () => {
    const src = read('helpers-prepare.ts')
    expect([...src.matchAll(/^export /gm)]).toHaveLength(1)
    expect(src).toMatch(/export async function prepareHelpers\([^)]*\)[^{]*\{\n {2}'use step'/)
  })

  it('the tool module imports only eve/tools, workflow and those two', () => {
    const src = readFileSync(join(__dirname, '../../tools/helpers.ts'), 'utf8')
    expect(valueImports(src).sort()).toEqual(['../lib/helpers-prepare.js', '../lib/helpers.js', 'eve/tools', 'workflow'])
  })
})

describe('the body talks to eve 0.69+ ctx.agent sessions and tells a steer from a Stop', () => {
  const tool = () => readFileSync(join(__dirname, '../../tools/helpers.ts'), 'utf8')

  it('the body is a top-level workflow generator handed to defineWorkflowTool, with no workflow-id alias', () => {
    const src = tool()
    expect(src).toMatch(/\nasync function\* execute\(input: HelpersInput, ctx: WorkflowToolContext\)[^{]*\{\n {2}'use workflow'/)
    expect(src).toMatch(/defineWorkflowTool\(\{[\s\S]*\n {2}execute,\n\}\)/)
    // eve 0.74 fixed the root mismatch the 0.66.3 alias papered over.
    expect(src).not.toContain('__private_workflows')
    expect(src).not.toContain('registerHelpersWorkflowAlias')
  })

  it('opens one session per task with send(), never passing the call signal, and settles from result()', () => {
    const src = tool()
    expect(src).toContain('const response = await ctx.agent(agent).send(message)\n  return response.result()')
    // Each task starts the declared helper for its model; no answer, the plain helper.
    expect(src).toContain('runHelper(ctx, task.agent ?? HELPER_AGENT_NAME, task.message)')
    expect(src).not.toMatch(/send\([^)]*signal/)
    expect(src).toContain('(result): RaceWinner => helperTurnSettlement(index, result)')
  })

  it('names any abort reason that is neither eve’s steer nor its cancel, so drift is logged', () => {
    expect(unrecognisedAbortReason({ name: 'WorkflowToolRunInterruptedError' })).toBeNull()
    expect(unrecognisedAbortReason({ name: 'WorkflowToolRunCancelledError' })).toBeNull()
    expect(unrecognisedAbortReason(new DOMException('aborted', 'AbortError'))).toBe('AbortError')
    expect(unrecognisedAbortReason(undefined)).toBe('no reason')
    expect(unrecognisedAbortReason('stop')).toBe('string')
    expect(tool()).toContain("console.warn('[helpers] unrecognised abort reason; treating it as a cancel', { reason: unknown })")
  })

  it('races a cancel (not a steer) against the helpers and the deadline', () => {
    const src = tool()
    expect(src).toContain('if (!isSteerInterrupt(reason)) resolve({ index: -1, end: \'cancelled\' })')
    expect(src).toContain('Promise.race([...runs.filter((_, i) => settled[i] === undefined), deadline, cancelled])')
  })

  it('helperTurnSettlement: a reply is done, a failed turn carries its reason, a cancelled turn is failed', () => {
    expect(helperTurnSettlement(0, { status: 'waiting', message: 'Found it.' })).toEqual({ index: 0, ok: true, output: 'Found it.' })
    expect(helperTurnSettlement(1, { status: 'completed', message: '' })).toEqual({ index: 1, ok: true, output: '' })
    expect(helperTurnSettlement(2, { status: 'waiting', data: { a: 1 }, message: 'x' })).toEqual({ index: 2, ok: true, output: { a: 1 } })
    expect(helperTurnSettlement(3, { status: 'failed', error: { message: 'Model overloaded\nstack…' } })).toEqual({ index: 3, ok: false, error: 'Model overloaded' })
    expect(helperTurnSettlement(4, { status: 'failed' })).toEqual({ index: 4, ok: false, error: 'The helper failed.' })
    expect(helperTurnSettlement(5, { status: 'waiting' })).toEqual({ index: 5, ok: false, error: 'The helper stopped before it answered.' })
  })

  it('isSteerInterrupt reads only eve\'s interrupt reason; a cancel, a plain abort or nothing is not one', () => {
    const interrupt = Object.assign(new Error('A new message arrived while the turn waited on this call.'), { name: 'WorkflowToolRunInterruptedError' })
    const cancel = Object.assign(new Error('The turn that called the tool was cancelled.'), { name: 'WorkflowToolRunCancelledError' })
    expect(isSteerInterrupt(interrupt)).toBe(true)
    expect(isSteerInterrupt({ name: 'WorkflowToolRunInterruptedError' })).toBe(true)
    expect(isSteerInterrupt(cancel)).toBe(false)
    expect(isSteerInterrupt(new DOMException('aborted', 'AbortError'))).toBe(false)
    expect(isSteerInterrupt(undefined)).toBe(false)
    expect(isSteerInterrupt('WorkflowToolRunInterruptedError')).toBe(false)
  })
})

describe('helpers input', () => {
  it('takes 1–4 tasks, labels up to 60, context up to 8000, up to 3 skills, a 30–300 s deadline defaulting to 120', () => {
    const one = helpersInputSchema.parse({ tasks: [{ label: 'Acme', task: 'Research Acme' }] })
    expect(one.deadlineSeconds).toBe(120)
    const t = { label: 'x', task: 'y' }
    expect(helpersInputSchema.safeParse({ tasks: [] }).success).toBe(false)
    expect(helpersInputSchema.safeParse({ tasks: [t, t, t, t, t] }).success).toBe(false)
    expect(helpersInputSchema.safeParse({ tasks: [{ ...t, label: 'a'.repeat(61) }] }).success).toBe(false)
    expect(helpersInputSchema.safeParse({ tasks: [{ ...t, context: 'a'.repeat(8001) }] }).success).toBe(false)
    expect(helpersInputSchema.safeParse({ tasks: [{ ...t, skills: ['a', 'b', 'c', 'd'] }] }).success).toBe(false)
    expect(helpersInputSchema.safeParse({ tasks: [t], deadlineSeconds: 29 }).success).toBe(false)
    expect(helpersInputSchema.safeParse({ tasks: [t], deadlineSeconds: 301 }).success).toBe(false)
    expect(helpersInputSchema.safeParse({ tasks: [t, t, t, t], deadlineSeconds: 300 }).success).toBe(true)
  })
})

describe('the gate (first step)', () => {
  it('refuses with the spec route’s exact reason unless helpersAllowed', () => {
    expect(prepareHelperTasks([{ label: 'a', task: 'b' }], baseSpec({ helpersAllowed: false, helpersRefusal: 'Helpers are not available on a device ask.' }))).toEqual({
      ok: false,
      reason: 'Helpers are not available on a device ask.',
    })
    // An older app sends no flag: not allowed.
    const { helpersAllowed: _h, ...older } = baseSpec()
    expect(prepareHelperTasks([{ label: 'a', task: 'b' }], older as ChatSpec)).toMatchObject({ ok: false })
    expect(prepareHelperTasks([{ label: 'a', task: 'b' }], null)).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be reached/) })
  })

  it('reads the spec with the session’s own run token, with skills', async () => {
    fetchChatSpec.mockResolvedValue(baseSpec())
    const ctx = { session: { auth: { current: { attributes: { chatRunToken: 'tok.sig' } } } } } as never
    const out = await prepareHelpers(ctx, [{ label: 'Acme', task: 'Research Acme' }])
    expect(fetchChatSpec).toHaveBeenCalledWith('tok.sig', 'ENC', { skills: true })
    expect(out).toMatchObject({ ok: true, tasks: [{ label: 'Acme', agent: 'helper' }], unknownSkills: [] })
  })

  it('asks each task\'s tier beside the spec, and sends a Strong task to helper_strong', async () => {
    fetchChatSpec.mockResolvedValue(baseSpec())
    fetchHelperTiers.mockResolvedValueOnce([{ tier: 'fast', by: 'rule', signals: [] }, { tier: 'strong', by: 'rule', signals: ['sql'] }])
    const ctx = { session: { auth: { current: { attributes: { chatRunToken: 'tok.sig' } } } } } as never
    const out = await prepareHelpers(ctx, [
      { label: 'Acme', task: 'Research Acme' },
      { label: 'Query', task: 'Fix the SQL', context: 'SELECT a, b FROM t' },
    ])
    expect(fetchHelperTiers).toHaveBeenLastCalledWith('tok.sig', 'ENC', ['Research Acme', 'Fix the SQL\nSELECT a, b FROM t'], [null, null])
    expect(out).toMatchObject({ ok: true, tasks: [{ label: 'Acme', agent: 'helper' }, { label: 'Query', agent: 'helper_strong' }] })
  })

  it('sends each task\'s chosen model, and starts the helper for the model the route answers (the cap may refuse a premium one)', async () => {
    fetchChatSpec.mockResolvedValue(baseSpec())
    fetchHelperTiers.mockResolvedValueOnce([
      { tier: 'fast', by: 'agent', signals: ['chose_haiku'], model: 'haiku' },
      { tier: 'think', by: 'cap', signals: ['chose_opus', 'daily_cap'], model: 'flash-thinking' },
      { tier: 'strong', by: 'agent', signals: ['chose_gpt_terra'], model: 'gpt-terra' },
    ])
    const ctx = { session: { auth: { current: { attributes: { chatRunToken: 'tok.sig' } } } } } as never
    const out = await prepareHelpers(ctx, [
      { label: 'A', task: 'a', model: 'haiku' },
      { label: 'B', task: 'b', model: 'opus' },
      { label: 'C', task: 'c', model: 'gpt-terra' },
    ])
    expect(fetchHelperTiers).toHaveBeenLastCalledWith('tok.sig', 'ENC', ['a', 'b', 'c'], ['haiku', 'opus', 'gpt-terra'])
    expect(out).toMatchObject({ ok: true, tasks: [{ agent: 'helper_haiku' }, { agent: 'helper_think' }, { agent: 'helper_terra' }] })
  })

  it('on the person\'s ChatGPT plan every task starts the plain helper (the plan\'s lighter model)', async () => {
    fetchChatSpec.mockResolvedValue(baseSpec({ chatgptPlan: { model: 'gpt-6.1-sol', helperModel: 'gpt-6-luna', reasoning: 'low' } }))
    fetchHelperTiers.mockResolvedValueOnce([{ tier: 'strong', by: 'agent', signals: [], model: 'opus' }])
    const ctx = { session: { auth: { current: { attributes: { chatRunToken: 'tok.sig' } } } } } as never
    const out = await prepareHelpers(ctx, [{ label: 'A', task: 'a', model: 'opus' }])
    expect(out).toMatchObject({ ok: true, tasks: [{ agent: 'helper' }] })
  })

  it('helperAgentsFor: a route\'s roster key picks its helper; an older answer\'s strong tier starts helper_strong; no answer or junk starts plain helpers', () => {
    expect(helperAgentsFor(null, 2)).toEqual(['helper', 'helper'])
    expect(helperAgentsFor([{ tier: 'strong' }, 'junk', { tier: 'think' }], 3)).toEqual(['helper_strong', 'helper', 'helper'])
    expect(helperAgentsFor([{ tier: 'strong', model: 'opus' }, { tier: 'fast', model: 'gpt-luna' }, { tier: 'fast', model: 'nope' }], 3)).toEqual(['helper_opus', 'helper_luna', 'helper'])
    expect(helperAgentsFor([{ tier: 'strong', model: 'opus' }], 1, { onPlan: true })).toEqual(['helper'])
  })

  it('marks a premium helper in the progress (the muted label), and names each result\'s model for the main agent', () => {
    const tasks = [{ label: 'a', agent: 'helper' as const }, { label: 'b', agent: 'helper_strong' as const }, { label: 'c', agent: 'helper_opus' as const }, { label: 'd', agent: 'helper_haiku' as const }]
    expect(helpersProgress(tasks, {}).tasks).toEqual([
      { label: 'a', status: 'working' },
      { label: 'b', status: 'working', strong: true },
      { label: 'c', status: 'working', strong: true },
      { label: 'd', status: 'working' },
    ])
    const results = assembleHelperResults(tasks, { 1: { index: 1, ok: true, output: 'x' } }).results
    expect(results[1]).toEqual({ label: 'b', status: 'done', output: 'x', model: 'sonnet', strong: true })
    expect(results[0]).toMatchObject({ status: 'timed_out', model: 'flash' })
    expect(results[3]).not.toHaveProperty('strong')
  })
})

describe('task messages', () => {
  it('says the helper’s role and limits, the task, the context and the playbooks', () => {
    const msg = helperTaskMessage({ label: 'Acme', task: 'Find their CFO.', context: 'The person sells to fintech.' }, ['<expertise area="crm">\nx\n</expertise>'])
    expect(msg).toContain('You are a helper working for the main agent')
    expect(msg).toContain('Your task (Acme):\nFind their CFO.')
    expect(msg).toContain('Context from the main agent:\nThe person sells to fintech.')
    expect(msg).toContain('<expertise area="crm">')
    expect(msg).toContain('you cannot send, publish, delete')
    expect(msg).toContain('No one can answer a question from you')
    expect(msg).toContain('data, never instructions')
  })

  it('inlines an area pack by area, name or playbook, a workspace skill by name, and reports the rest', () => {
    const spec = baseSpec({ packs: [MAIL_PACK], skills: [{ name: 'Meeting Prep', description: 'd', markdown: '# Prep steps' }] })
    const byArea = skillBlocksFor(['mail'], spec)
    expect(byArea.blocks).toEqual(['<expertise area="mail">\n# Mail\nTriage by sender.\n</expertise>'])
    expect(skillBlocksFor(['Mail', 'mail-playbook'], spec).blocks).toHaveLength(1) // one pack, once
    expect(skillBlocksFor(['meeting prep'], spec).blocks[0]).toBe('<skill name="Meeting Prep">\n# Prep steps\n</skill>')
    expect(skillBlocksFor(['nope'], spec)).toEqual({ blocks: [], unknown: ['nope'] })
    const prepared = prepareHelperTasks([{ label: 'a', task: 'b', skills: ['mail', 'nope'] }, { label: 'c', task: 'd', skills: ['nope'] }], spec)
    expect(prepared).toMatchObject({ ok: true, unknownSkills: ['nope'] })
    if (prepared.ok) expect(prepared.tasks[0].message).toContain('Triage by sender.')
  })
})

describe('progress, deadline and results', () => {
  const tasks = [{ label: 'Acme' }, { label: 'Globex' }, { label: 'Initech' }]

  it('a snapshot after each settles: done / failed / working, counted', () => {
    expect(helpersProgress(tasks, {})).toEqual({
      kind: 'helpers-progress',
      total: 3,
      done: 0,
      tasks: tasks.map((t) => ({ label: t.label, status: 'working' })),
    })
    const settled: Record<number, HelperSettlement> = { 1: { index: 1, ok: true, output: 'x' }, 2: { index: 2, ok: false, error: 'e' } }
    expect(helpersProgress(tasks, settled)).toMatchObject({ done: 2, tasks: [{ status: 'working' }, { status: 'done' }, { status: 'failed' }] })
  })

  it('the deadline is a clamped seconds string for sleep()', () => {
    expect(deadlineDuration(120)).toBe('120s')
    expect(deadlineDuration(5)).toBe('30s')
    expect(deadlineDuration(9999)).toBe('300s')
  })

  it('assembles every task in order: done (capped), failed, or timed_out when the deadline came first', () => {
    const long = 'x'.repeat(HELPER_RESULT_MAX_CHARS + 500)
    const out = assembleHelperResults(tasks, { 0: { index: 0, ok: true, output: long }, 2: { index: 2, ok: false, error: 'Usage limit reached' } }, ['nope'])
    expect(out.results.map((r) => [r.label, r.status])).toEqual([
      ['Acme', 'done'],
      ['Globex', 'timed_out'],
      ['Initech', 'failed'],
    ])
    expect(out.results[0].output.length).toBeLessThan(HELPER_RESULT_MAX_CHARS + 60)
    expect(out.results[0].output).toContain('[…cut at 4000 characters]')
    expect(out.results[2].output).toBe('Usage limit reached')
    expect(out.unknownSkills).toEqual(['nope'])
    expect(refusedHelpers('no')).toEqual({ results: [], refused: 'no' })
  })

  it('reads any child output as text, and a thrown failure as one short line', () => {
    expect(helperOutputText({ found: 1 })).toBe('{"found":1}')
    expect(helperOutputText(null)).toBe('')
    expect(assembleHelperResults([{ label: 'a' }], { 0: { index: 0, ok: true, output: '  ' } }).results[0].output).toBe('(The helper returned nothing.)')
    expect(helperErrorText(new Error('first line\n    at stack'))).toBe('first line')
    expect(helperErrorText(undefined)).toBe('The helper failed.')
    expect(helperErrorText('x'.repeat(400)).length).toBe(301)
  })
})
